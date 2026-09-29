/**
 * The rows themselves — ungated by licence (the drain exemption).
 *
 * Read a page, read one, add, edit, import a spreadsheet, export the lot as
 * CSV, delete one, delete a selection. Every statement is compiled by
 * core/dataEngine/queryCompiler with the access filter ANDed in; a table that
 * mirrors an external source writes to the source first and copies back.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const accessFilter = require('../../core/dataEngine/accessFilter');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');
const sources = require('../../core/dataEngine/sources');
const {
    PG, ROWS_PAGE_MAX, EXPORT_MAX_ROWS, BULK_MAX_ROWS, BULK_CHUNK,
    BULK_DELETE_MAX_IDS, MIRROR_BULK_MAX_ROWS,
} = require('./engine');
const { requireDatatableGrade, metaAndFilter, metaFor } = require('./grade');
const { assertQuota, answerDatatableError } = require('./refusals');
const { readListDescriptor } = require('./rowDescriptor');
const { mirrorCtx, mirrorWrites } = require('./source');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, choice, idText } = require('./schemas');
const log = require('../../telemetry/log');

// ── What a caller may send ──────────────────────────────────────────
//
// The LIST query is `.strict()`, and that is the point of this block. Every
// parameter here NARROWS what comes back, so a misspelled one used to be
// dropped and the list then answered a WIDER question than the one it was
// asked — `?fitlers=[…]` returned the whole table to somebody looking at what
// they believed was a filtered view, under a 200. The descriptor's own checks
// (rowDescriptor.js) close the INSIDE of `filters`; nothing closed the set of
// parameter names.
//
// The Studio sends exactly these seven (datatablesApi.listRows).
const NUM_TEXT = 'limit is a number of rows.';
const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
const ListQuery = z.object({
    // JSON on the wire; rowDescriptor.readFilters parses it and resolves
    // every field key against THIS table's declared columns.
    filters: one('filters', 'a list of {field, op, value} as JSON'),
    match: choice(queryCompiler.MATCH_MODES, 'Rows match all of the conditions, or any of them').optional(),
    sort: one('sort', 'a column of this table'),
    dir: choice(['asc', 'desc'], 'Sort ascending or descending').optional(),
    q: worded('q is the text to look for.').optional(),
    // Clamped by the compiler's own rule (queryCompiler.clampLimit), never
    // re-derived here — a route that derived its own let `?limit=-5` through
    // and then sliced by it. What the schema adds is that `?limit=veel` is
    // named rather than silently becoming the default page.
    limit: z.coerce.number({ invalid_type_error: NUM_TEXT }).int(NUM_TEXT).positive(NUM_TEXT).optional(),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
}).strict();

const VALUES_TEXT = 'Say which columns to set — { values: { … } }';
const values = () => z.record(z.unknown(), { required_error: VALUES_TEXT, invalid_type_error: VALUES_TEXT });

const UPDATED_AT_TEXT = 'Send the updated_at you read, so a colleague\'s edit is not silently overwritten';

// `values` is REQUIRED, not `req.body?.values || {}`. That fall-back turned a
// misspelled key — `{"valeus": {...}}` — into an INSERT of a row with nothing
// in it, answered 200 with the id of the empty row it had just made.
const InsertBody = bodyOf({ values: values() });

const UpdateBody = bodyOf({
    values: values().refine((v) => Object.keys(v).length > 0, { message: VALUES_TEXT }),
    expectedUpdatedAt: idText(UPDATED_AT_TEXT),
});

const ROWS_TEXT = 'Send { rows: [...] }';
const BulkBody = bodyOf({
    // Per-ROW shape is reported by LINE from inside the handler: a 400-row
    // paste with two bad dates in it is a fixable import, not one refusal.
    rows: z.array(z.unknown(), { required_error: ROWS_TEXT, invalid_type_error: ROWS_TEXT }),
});

const IDS_TEXT = 'Send { ids: ["rec_…", …] }';
const BulkDeleteBody = bodyOf({
    ids: z.array(idText(IDS_TEXT), { required_error: IDS_TEXT, invalid_type_error: IDS_TEXT }),
});

// The routes that read nothing at all from the request but the path.
const NO_QUERY = z.object({}).strict();
const NOTHING = bodyOf({});

/**
 * The CSV export takes no descriptor, and says so.
 *
 * It streams the whole table under the same access filter as a read — there
 * is no `?filters=` here and there never was. Strict rather than ignored: a
 * client that appended the row list's filters would otherwise download
 * EVERY row while believing it had exported the view on screen.
 */
const ExportQuery = z.object({}).strict();

function register(router) {
    router.get('/:id/rows', requireDatatableGrade('viewer'), validate({ query: ListQuery }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'read');
            const compiled = queryCompiler.compileRecordList(meta, {
                ...readListDescriptor(meta, req.query),
                // Clamped by the compiler's OWN rule. The route used to derive its
                // own — `Math.min(Number(limit) || 50, MAX)` — which let `?limit=-5`
                // through as -5: the SQL then ran at the compiler's default of 50
                // and `rows.slice(0, -5)` returned 46 of them while reporting more.
                limit: req.query.limit, maxLimit: ROWS_PAGE_MAX,
                cursor: req.query.cursor ?? null, dialect: 'pg',
            }, filter);
            const out = await datatableDbStore.query(
                req.datatableScopeKey, req.datatableScopeKey, compiled.sql, compiled.params);
            // compileRecordList deliberately asks for limit+1 as a cursor probe.
            // stepDataSource documents the bug where that extra row leaked out.
            const limit = compiled.limit;
            const all = out.rows || [];
            const rows = all.slice(0, limit);
            const hasMore = all.length > limit;
            const last = rows[rows.length - 1];
            res.json({
                rows,
                hasMore,
                count: rows.length,
                // The cursor the NEXT page is asked for with. It was accepted on the
                // way in and never produced on the way out, so page 2 was
                // unreachable through this API.
                nextCursor: (hasMore && last)
                    ? queryCompiler.encodeCursor(last[compiled.primaryField], last.id)
                    : null,
                // What "the 50 most recent of N" needs. row_count is arithmetic, so
                // it is approximate between retention sweeps — the surface says so.
                total: req.datatable.rowCount,
            });
            // Somebody is LOOKING at a mirror: refresh it behind the answer when
            // the copy is older than its schedule (stale-while-serve). Guarded
            // and debounced inside; never affects the response above.
            if (sources.isSourceMirror(req.datatable)) {
                sources.kickStale(req.datatable, { reason: 'view' });
            }
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] row read failed:', e.message);
            res.status(500).json({ error: 'Could not read the rows' });
        }
    });

    /**
     * ONE row. The access filter is ANDed in, so a row the caller may not see
     * returns 0 rows and reads as 404 — the same rule the whole surface follows.
     */
    router.get('/:id/rows/:rowId', requireDatatableGrade('viewer'), validate({ query: NO_QUERY }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'read');
            const { sql, params } = queryCompiler.compileGetById(meta, req.params.rowId, filter, PG);
            const out = await datatableDbStore.query(
                req.datatableScopeKey, req.datatableScopeKey, sql, params);
            const row = (out.rows || [])[0];
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.json({ row });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] row read failed:', e.message);
            res.status(500).json({ error: 'Could not read the row' });
        }
    });

    router.post('/:id/rows', requireDatatableGrade('editor'), validate({ body: InsertBody, query: NO_QUERY }), async (req, res) => {
        try {
            const meta = await metaFor(req);
            accessFilter.assertCanWrite(meta, req.datatableGrade, 'create');
            await assertQuota(req, { addRows: 1 });
            // A mirror's row goes to the source first; the copy is written from
            // what the source answered (core/dataEngine/sources).
            if (sources.isSourceMirror(req.datatable)) {
                const r = await mirrorWrites().insertRow(mirrorCtx(req, meta), req.body.values);
                return res.json({ ok: true, id: r.id });
            }
            const { sql, params, id } = queryCompiler.compileInsert(meta, req.body.values, {
                createdBy: req.datatablePrincipal.userId,
                // NULL on a personal table, and correct: `org_id` records which
                // organisation the row belongs to, and a personal row belongs to
                // none. Inventing one here would make the row look shared.
                orgId: req.datatable.organizationId,
                dialect: 'pg',
            });
            await datatableDbStore.exec(
                req.datatableScopeKey, req.datatableScopeKey, sql, params);
            await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, 1);
            // The id compileInsert minted, so the caller can address the row it
            // just added without re-reading the page to find it.
            res.json({ ok: true, id });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] row write failed:', e.message);
            res.status(500).json({ error: 'Could not add the row' });
        }
    });

    /**
     * EDIT a row.
     *
     * There was no way to change one anywhere in the product, so fixing a typo
     * meant delete-and-retype: a new id, a new created_at, a lost created_by, and
     * every routine keyed on the row id pointing at nothing.
     *
     * `expectedUpdatedAt` is REQUIRED, not optional. compileUpdate has carried the
     * token from the start and every read returns `updated_at`, so a client cannot
     * fail to have one — while a save without it is last-write-wins on a surface
     * two colleagues can have open at once. 400 when it is absent, 409
     * `row_conflict` when it is stale, and the two are told apart by re-reading the
     * row: "changed under you" and "gone / not yours" need different answers.
     */
    router.put('/:id/rows/:rowId', requireDatatableGrade('editor'), validate({ body: UpdateBody, query: NO_QUERY }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'update');
            accessFilter.assertCanWrite(meta, req.datatableGrade, 'update');

            const { values, expectedUpdatedAt } = req.body;

            // Same three answers as below — 404, 409 row_conflict, {row} — with
            // the source asked in between.
            if (sources.isSourceMirror(req.datatable)) {
                const r = await mirrorWrites().updateRow(mirrorCtx(req, meta), req.params.rowId, values, { expectedUpdatedAt });
                if (!r.changes) {
                    if (!r.row) return res.status(404).json({ error: 'Not found' });
                    return res.status(409).json({
                        error: 'Someone else changed this row while you had it open',
                        code: 'row_conflict',
                        row: r.row,
                    });
                }
                return res.json({ row: r.row });
            }

            const upd = queryCompiler.compileUpdate(meta, req.params.rowId, values, filter,
                { expectedUpdatedAt, dialect: 'pg' });
            const out = await datatableDbStore.exec(
                req.datatableScopeKey, req.datatableScopeKey, upd.sql, upd.params);

            // Read it back either way: on success the caller needs the new
            // updated_at for its NEXT edit, and on failure the row itself is the
            // difference between "somebody else changed it" and "it is not there".
            const probe = queryCompiler.compileGetById(meta, req.params.rowId, filter, PG);
            const found = await datatableDbStore.query(
                req.datatableScopeKey, req.datatableScopeKey, probe.sql, probe.params);
            const row = (found.rows || [])[0] || null;

            if (!out?.changes) {
                if (!row) return res.status(404).json({ error: 'Not found' });
                return res.status(409).json({
                    error: 'Someone else changed this row while you had it open',
                    code: 'row_conflict',
                    row,
                });
            }
            // data_version moves, row_count does not — an edit adds no rows.
            await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, 0);
            res.json({ row });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] row edit failed:', e.message);
            res.status(500).json({ error: 'Could not save the row' });
        }
    });

    /**
     * BULK IMPORT — a spreadsheet, in one request.
     *
     * Every row is validated against the declared columns BEFORE anything is
     * written, and the answer is per-row errors WITH THEIR LINE NUMBERS rather than
     * one refusal for the whole file: a 400-row paste with two bad dates in it is a
     * fixable import, and "invalid input syntax for type timestamptz" is not an
     * answer a person can act on.
     *
     * Writes go through datatableDbStore.batch in chunks — one transaction per
     * chunk, so a failure part-way leaves the chunk unapplied instead of half of
     * it, and row_count is bumped by what actually landed.
     */
    router.post('/:id/rows/bulk', requireDatatableGrade('editor'), validate({ body: BulkBody, query: NO_QUERY }), async (req, res) => {
        try {
            const meta = await metaFor(req);
            accessFilter.assertCanWrite(meta, req.datatableGrade, 'create');

            const { rows } = req.body;
            if (!rows.length) return res.json({ inserted: 0, errors: [] });
            if (rows.length > BULK_MAX_ROWS) {
                return res.status(413).json({
                    error: `An import carries at most ${BULK_MAX_ROWS} rows — split the file`,
                    code: 'too_many_rows', limit: BULK_MAX_ROWS, used: rows.length,
                });
            }

            // The whole file is compiled first. A row that cannot be compiled is
            // reported with its line and simply not written; nothing is written at
            // all until every row has been looked at, so the error list is complete
            // rather than "everything up to the first bad line".
            const statements = [];
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
                    // +1 because a person counts the first row as row 1, and a
                    // header line is the caller's to account for.
                    errors.push({ line: i + 1, error: e.message });
                }
            });
            if (!statements.length) return res.status(422).json({ inserted: 0, errors });

            await assertQuota(req, { addRows: statements.length });

            // A mirror's rows go to the source, capped, and a row the source
            // refuses is reported with its line while the rest go on — the same
            // per-row contract as a local import, at the source's pace. The
            // engine's batch form does it in ONE source write where the source
            // has one (a file rewritten once), row by row where it has not.
            if (sources.isSourceMirror(req.datatable)) {
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
                    for (const { index, error: e } of out.errors) {
                        errors.push({ line: pending[index].line, error: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });
                    }
                } else {
                    for (const p of pending) {
                        try {
                            await wt.insertRow(ctx, p.values);
                            done += 1;
                        } catch (e) {
                            errors.push({ line: p.line, error: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });
                            // The source unreachable: stop rather than report N copies of it.
                            if (e && e.errorClass === 'datatable_source_unavailable') break;
                        }
                    }
                }
                return res.status(errors.length && !done ? 422 : 200).json({ inserted: done, errors });
            }

            let inserted = 0;
            try {
                for (let i = 0; i < statements.length; i += BULK_CHUNK) {
                    const chunk = statements.slice(i, i + BULK_CHUNK);
                    await datatableDbStore.batch(req.datatableScopeKey, req.datatableScopeKey,
                        chunk.map(c => ({ sql: c.sql, params: c.params })));
                    inserted += chunk.length;
                    // Bumped per chunk, not once at the end: a later chunk failing
                    // must not leave the counter denying rows that are really there.
                    await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, chunk.length);
                }
            } catch (e) {
                // A chunk is one transaction, so nothing from it landed. Report what
                // did, and why the rest did not.
                return res.status(422).json({
                    inserted,
                    errors: [...errors, { line: inserted + errors.length + 1, error: e.message }],
                    code: e.code || 'import_failed',
                });
            }
            res.json({ inserted, errors });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] bulk import failed:', e.message);
            res.status(500).json({ error: 'Could not import the rows' });
        }
    });

    /** One CSV cell. */
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
     * CSV EXPORT — the whole table, in ONE response.
     *
     * Streamed by keyset page rather than buffered: a 100,000-row table is 2,000
     * requests at the row list's page size and one array of 100,000 objects in
     * memory if it is assembled first. The access filter is compiled exactly as it
     * is for a read, so an export can never contain a row the caller could not
     * already see on screen.
     */
    router.get('/:id/rows.csv', requireDatatableGrade('viewer'), validate({ query: ExportQuery }),
        require('../../compliance/dataPortability/stampExport')('datatables'), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'read');
            const columns = [
                ...dataModel.SYSTEM_COLUMNS,
                ...(meta.fields || []).map(f => f && f.key).filter(Boolean),
            ];
            const safeName = String(req.datatable.key || 'datatable').replace(/[^a-z0-9_-]/gi, '') || 'datatable';
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
            // A CSV Excel opens as UTF-8 rather than as the local code page.
            res.write('﻿' + columns.map(csvCell).join(',') + '\n');

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
                for (const row of page) res.write(columns.map(c => csvCell(row[c])).join(',') + '\n');
                written += page.length;
                const last = page[page.length - 1];
                if (all.length <= compiled.limit || !last || written >= EXPORT_MAX_ROWS) break;
                cursor = queryCompiler.encodeCursor(last[compiled.primaryField], last.id);
                // A cursor that cannot be built would restart the same page for
                // ever. Stop instead of looping.
                if (!cursor) break;
            }
            res.end();
        } catch (e) {
            // Headers may already be out — a half-written CSV cannot become a JSON
            // error, so the only honest end is to stop the stream.
            if (res.headersSent) { try { res.end(); } catch { /* client gone */ } return; }
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] export failed:', e.message);
            res.status(500).json({ error: 'Could not export the rows' });
        }
    });

    router.delete('/:id/rows/:rowId', requireDatatableGrade('editor'), validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'delete');
            accessFilter.assertCanWrite(meta, req.datatableGrade, 'delete');
            if (sources.isSourceMirror(req.datatable)) {
                const r = await mirrorWrites().deleteRow(mirrorCtx(req, meta), req.params.rowId);
                if (!r.changes) return res.status(404).json({ error: 'Not found' });
                // A row-number mirror renumbers every row below the one that went;
                // the client reloads on this flag instead of trusting its list.
                return res.json({ ok: true, ...(r.renumbered ? { renumbered: true } : {}) });
            }
            const { sql, params } = queryCompiler.compileDelete(meta, req.params.rowId, filter, PG);
            const out = await datatableDbStore.exec(
                req.datatableScopeKey, req.datatableScopeKey, sql, params);
            // The access filter is ANDed into the statement, so "nothing changed"
            // covers both a row that never existed and one this caller may not see —
            // 404 either way, and no counter move. Decrementing unconditionally is
            // what let N deletes of nothing walk row_count down to 0 on a full
            // table: GREATEST(0, …) hides the underflow and the quota then passes
            // forever.
            if (!out?.changes) return res.status(404).json({ error: 'Not found' });
            await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, -1);
            res.json({ ok: true });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] row delete failed:', e.message);
            res.status(500).json({ error: 'Could not delete the row' });
        }
    });

    /**
     * POST /:id/rows/bulk-delete { ids } — a selection, deleted in ONE transaction.
     *
     * The single delete's path, N times: the same compiled statement with the same
     * access predicate ANDed in, so a row the caller may not see is not deleted
     * and not counted, and the counter only moves by what Postgres reports gone.
     * One engine batch rather than N round trips, and all-or-nothing: a selection
     * that half-vanished is harder to reason about than one that did not.
     *
     * Answers `{ deleted, requested }` — a 200 with `deleted: 0` when none of the
     * ids were there or visible, where the single delete says 404. A selection is
     * a set of guesses about the current page; "none of them applied" is a result,
     * not a missing resource.
     */
    router.post('/:id/rows/bulk-delete', requireDatatableGrade('editor'), validate({ body: BulkDeleteBody, query: NO_QUERY }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'delete');
            accessFilter.assertCanWrite(meta, req.datatableGrade, 'delete');

            const ids = [...new Set(req.body.ids)];
            if (!ids.length) return res.json({ deleted: 0, requested: 0 });
            if (ids.length > BULK_DELETE_MAX_IDS) {
                return res.status(413).json({
                    error: `At most ${BULK_DELETE_MAX_IDS} rows can be deleted at once`,
                    code: 'too_many_ids', limit: BULK_DELETE_MAX_IDS, used: ids.length,
                });
            }

            if (sources.isSourceMirror(req.datatable)) {
                const wt = sources.writeThrough(req.datatable);
                const ctx = mirrorCtx(req, meta);
                let gone = 0;
                let renumbered = false;
                if (typeof wt.deleteRows === 'function') {
                    const r = await wt.deleteRows(ctx, ids);
                    gone = r.changed;
                    renumbered = !!r.renumbered;
                } else {
                    for (const id of ids) {
                        const r = await wt.deleteRow(ctx, id);
                        gone += r.changes;
                        renumbered = renumbered || !!r.renumbered;
                    }
                }
                return res.json({ deleted: gone, requested: ids.length, ...(renumbered ? { renumbered: true } : {}) });
            }

            const statements = ids.map(id => queryCompiler.compileDelete(meta, id, filter, PG));
            const results = await datatableDbStore.batch(req.datatableScopeKey, req.datatableScopeKey,
                statements.map(c => ({ sql: c.sql, params: c.params })));
            const deleted = results.reduce((n, r) => n + (Number(r?.changes) || 0), 0);
            // Same rule as the single delete: the counter moves by what really
            // went, never by what was asked, or N deletes of nothing walk it to 0.
            if (deleted > 0) await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, -deleted);
            res.json({ deleted, requested: ids.length });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] bulk delete failed:', e.message);
            res.status(500).json({ error: 'Could not delete the rows' });
        }
    });
}

module.exports = { register };
