// @typecheck strict
/**
 * The rows in bulk: the handler bodies of the spreadsheet import and the CSV
 * export. The route table and the request schemas stay in rows.js. Split out
 * of rows.js; behaviour unchanged.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const accessFilter = require('../../core/dataEngine/accessFilter');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');
const sources = require('../../core/dataEngine/sources');
const { ROWS_PAGE_MAX, EXPORT_MAX_ROWS, BULK_MAX_ROWS, BULK_CHUNK, MIRROR_BULK_MAX_ROWS } = require('./engine');
const { metaAndFilter, metaFor } = require('./grade');
const { assertQuota, answerDatatableError } = require('./refusals');
const { mirrorCtx } = require('./source');
const { answering } = require('./rowHandlers');
const log = require('../../telemetry/log');

/** @typedef {import('./grade').DatatableRequest} DatatableRequest */
/** @typedef {Awaited<ReturnType<typeof metaFor>>} TableMeta */
/** @typedef {{ line: number, error: string, code?: string }} LineError */

/** @param {number} line @param {Error & { code?: unknown }} e @returns {LineError} */
const lineError = (line, e) => ({ line, error: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });

/**
 * The whole file is compiled first. A row that cannot be compiled is
 * reported with its line and simply not written; nothing is written at all
 * until every row has been looked at, so the error list is complete rather
 * than "everything up to the first bad line".
 * @param {DatatableRequest} req
 * @param {TableMeta} meta
 * @param {Record<string, unknown>[]} rows
 */
function compileImport(req, meta, rows) {
    /** @type {({ sql: string; params: unknown[]; id: string; createdAt: string; })[]} */
    const statements = [];
    /** @type {LineError[]} */
    const errors = [];
    rows.forEach((values, i) => {
        try {
            if (!values || typeof values !== 'object' || Array.isArray(values)) {
                throw new Error('a row is a map of column → value');
            }
            statements.push(queryCompiler.compileInsert(meta, values, {
                createdBy: req.datatablePrincipal.userId,
                orgId: req.datatable.organizationId,
                dialect: 'pg',
            }));
        } catch (e) {
            // A Solution stage's reference table refuses EVERY row
            // (queryCompiler RowsLockedError): that is the request's answer, a
            // 409 managed_part, not a bad line per row.
            if (e && e.code === 'managed_part') throw e;
            // +1 because a person counts the first row as row 1, and a header
            // line is the caller's to account for.
            errors.push({ line: i + 1, error: /** @type {Error} */ (e).message });
        }
    });
    return { statements, errors };
}

/**
 * A mirror's rows go to the source, capped, and a row the source refuses is
 * reported with its line while the rest go on: the same per-row contract as
 * a local import, at the source's pace. The engine's batch form does it in
 * ONE source write where the source has one (a file rewritten once), row by
 * row where it has not.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 * @param {TableMeta} meta
 * @param {Record<string, unknown>[]} rows
 * @param {LineError[]} errors
 */
async function importAtSource(req, res, meta, rows, errors) {
    if (rows.length > MIRROR_BULK_MAX_ROWS) {
        return res.status(413).json({
            error: `A linked table takes at most ${MIRROR_BULK_MAX_ROWS} rows per import — split the file`,
            code: 'too_many_rows', limit: MIRROR_BULK_MAX_ROWS, used: rows.length,
        });
    }
    const wt = sources.writeThrough(req.datatable);
    const ctx = mirrorCtx(req, meta);
    const pending = rows.map((values, i) => ({ line: i + 1, values })).filter(p => !errors.some(e => e.line === p.line));
    let done = 0;
    if (typeof wt.insertRows === 'function') {
        const out = await wt.insertRows(ctx, pending.map(p => p.values), { collect: true });
        done = out.inserted.length;
        for (const { index, error: e } of out.errors) errors.push(lineError(pending[index].line, /** @type {Error} */ (e)));
    } else {
        for (const p of pending) {
            try {
                await wt.insertRow(ctx, p.values);
                done += 1;
            } catch (e) {
                errors.push(lineError(p.line, e));
                // The source unreachable: stop rather than report N copies of it.
                if (e && e.errorClass === 'datatable_source_unavailable') break;
            }
        }
    }
    return res.status(errors.length && !done ? 422 : 200).json({ inserted: done, errors });
}

/**
 * Writes go through datatableDbStore.batch in chunks: one transaction per
 * chunk, so a failure part-way leaves the chunk unapplied instead of half of
 * it, and row_count is bumped by what actually landed.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 * @param {{ sql: string; params: unknown[]; id: string; createdAt: string; }[]} statements
 * @param {LineError[]} errors
 */
async function importLocally(req, res, statements, errors) {
    let inserted = 0;
    try {
        for (let i = 0; i < statements.length; i += BULK_CHUNK) {
            const chunk = statements.slice(i, i + BULK_CHUNK);
            await datatableDbStore.batch(req.datatableScopeKey, req.datatableScopeKey,
                chunk.map(c => ({ sql: c.sql, params: c.params })));
            inserted += chunk.length;
            // Bumped per chunk, not once at the end: a later chunk failing must
            // not leave the counter denying rows that are really there.
            await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, chunk.length);
        }
    } catch (e) {
        // A chunk is one transaction, so nothing from it landed. Report what
        // did, and why the rest did not.
        return res.status(422).json({
            inserted,
            errors: [...errors, { line: inserted + errors.length + 1, error: /** @type {Error} */ (e).message }],
            code: e.code || 'import_failed',
        });
    }
    res.json({ inserted, errors });
}

/**
 * BULK IMPORT — a spreadsheet, in one request. Every row is validated
 * against the declared columns BEFORE anything is written, and the answer is
 * per-row errors WITH THEIR LINE NUMBERS rather than one refusal for the
 * whole file.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 */
async function bulkImport(req, res) {
    const meta = await metaFor(req);
    accessFilter.assertCanWrite(meta, req.datatableGrade, 'create');
    // Refused whole, before the size cap and the quota (see the single insert).
    queryCompiler.assertRowsWritable(meta);

    const { rows } = req.body;
    if (!rows.length) return res.json({ inserted: 0, errors: [] });
    if (rows.length > BULK_MAX_ROWS) {
        return res.status(413).json({
            error: `An import carries at most ${BULK_MAX_ROWS} rows — split the file`,
            code: 'too_many_rows', limit: BULK_MAX_ROWS, used: rows.length,
        });
    }
    const { statements, errors } = compileImport(req, meta, rows);
    if (!statements.length) return res.status(422).json({ inserted: 0, errors });

    await assertQuota(req, { addRows: statements.length });
    if (sources.isSourceMirror(req.datatable)) return importAtSource(req, res, meta, rows, errors);
    return importLocally(req, res, statements, errors);
}

/** One CSV cell. @param {unknown} v */
function csvCell(v) {
    if (v === null || v === undefined) return '';
    let text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // A leading =, +, - or @ makes Excel and Sheets treat the cell as a
    // FORMULA when the export is opened, which is how a datatable column turns
    // into code running on a colleague's machine. Prefixed with a quote, it is
    // text again.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Write every visible row, page by keyset page, up to EXPORT_MAX_ROWS.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 * @param {TableMeta} meta
 * @param {Awaited<ReturnType<typeof metaAndFilter>>['filter']} filter
 * @param {string[]} columns
 */
async function writeCsvRows(req, res, meta, filter, columns) {
    /** @type {string | null} */
    let cursor = null;
    let written = 0;
    for (;;) {
        const compiled = queryCompiler.compileRecordList(meta, {
            limit: ROWS_PAGE_MAX, maxLimit: ROWS_PAGE_MAX, cursor, dialect: 'pg',
        }, filter);
        const out = await datatableDbStore.query(
            req.datatableScopeKey, req.datatableScopeKey, compiled.sql, compiled.params);
        const all = out.rows || [];
        const page = all.slice(0, compiled.limit);
        for (const row of page) res.write(columns.map((/** @type {string | number} */ c) => csvCell(row[c])).join(',') + '\n');
        written += page.length;
        const last = page[page.length - 1];
        if (all.length <= compiled.limit || !last || written >= EXPORT_MAX_ROWS) break;
        cursor = queryCompiler.encodeCursor(last[compiled.primaryField], last.id);
        // A cursor that cannot be built would restart the same page for ever.
        // Stop instead of looping.
        if (!cursor) break;
    }
}

/**
 * CSV EXPORT — the whole table, in ONE response, streamed by keyset page
 * rather than buffered. The access filter is compiled exactly as it is for a
 * read, so an export can never contain a row the caller could not already
 * see on screen.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 */
async function exportCsv(req, res) {
    try {
        const { meta, filter } = await metaAndFilter(req, 'read');
        const columns = [
            ...dataModel.SYSTEM_COLUMNS,
            ...(meta.fields || []).map((/** @type {{ key?: string }} */ f) => f && f.key).filter(Boolean),
        ];
        const safeName = String(req.datatable.key || 'datatable').replace(/[^a-z0-9_-]/gi, '') || 'datatable';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
        // A CSV Excel opens as UTF-8 rather than as the local code page.
        res.write('﻿' + columns.map(csvCell).join(',') + '\n');
        await writeCsvRows(req, res, meta, filter, columns);
        res.end();
    } catch (e) {
        // Headers may already be out: a half-written CSV cannot become a JSON
        // error, so the only honest end is to stop the stream.
        if (res.headersSent) { try { res.end(); } catch (err) { log.debug('client already gone', err); } return; }
        if (answerDatatableError(res, e, req.datatableScope)) return;
        throw e;
    }
}

module.exports = { bulkImport: answering(bulkImport), exportCsv };
