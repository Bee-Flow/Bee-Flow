// @typecheck strict
/**
 * The rows themselves: the handler bodies of read a page, read one, add,
 * edit, delete one and delete a selection. The route table and the request
 * schemas stay in rows.js; the bulk import and the CSV export live in
 * rowTransfer.js. Every statement is compiled by core/dataEngine/queryCompiler
 * with the access filter ANDed in; a table that mirrors an external source
 * writes to the source first and copies back. Split out of rows.js;
 * behaviour unchanged.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const accessFilter = require('../../core/dataEngine/accessFilter');
const sources = require('../../core/dataEngine/sources');
const { PG, ROWS_PAGE_MAX, BULK_DELETE_MAX_IDS } = require('./engine');
const { metaAndFilter, metaFor } = require('./grade');
const { assertQuota, answerDatatableError } = require('./refusals');
const { readListDescriptor } = require('./rowDescriptor');
const { mirrorCtx, mirrorWrites } = require('./source');

/** @typedef {import('./grade').DatatableRequest} DatatableRequest */
/** @typedef {(req: DatatableRequest, res: import('express').Response) => Promise<unknown>} RowHandler */

/**
 * A handler whose datatable refusals (quota, grade, managed part, ...) are answered, anything else thrown on.
 * @param {RowHandler} handler
 */
const answering = (handler) => async (/** @type {DatatableRequest} */ req, /** @type {import('express').Response} */ res) => {
    try {
        return await handler(req, res);
    } catch (e) {
        if (answerDatatableError(res, e, req.datatableScope)) return undefined;
        throw e;
    }
};

/** @param {unknown} row */
function conflictBody(row) {
    return {
        error: 'Someone else changed this row while you had it open',
        code: 'row_conflict',
        row,
    };
}

/** @param {DatatableRequest} req @param {import('express').Response} res */
async function listRows(req, res) {
    const { meta, filter } = await metaAndFilter(req, 'read');
    const compiled = queryCompiler.compileRecordList(meta, {
        ...readListDescriptor(meta, req.query),
        // Clamped by the compiler's OWN rule. The route used to derive its own
        // (`Math.min(Number(limit) || 50, MAX)`), which let `?limit=-5` through
        // as -5: the SQL then ran at the compiler's default of 50 and
        // `rows.slice(0, -5)` returned 46 of them while reporting more.
        limit: req.query.limit, maxLimit: ROWS_PAGE_MAX,
        cursor: /** @type {string | undefined} */ (req.query.cursor) ?? null, dialect: 'pg',
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
        // way in and never produced on the way out, so page 2 was unreachable
        // through this API.
        nextCursor: (hasMore && last)
            ? queryCompiler.encodeCursor(last[compiled.primaryField], last.id)
            : null,
        // What "the 50 most recent of N" needs. row_count is arithmetic, so it
        // is approximate between retention sweeps; the surface says so.
        total: req.datatable.rowCount,
    });
    // Somebody is LOOKING at a mirror: refresh it behind the answer when the
    // copy is older than its schedule (stale-while-serve). Guarded and
    // debounced inside; never affects the response above.
    if (sources.isSourceMirror(req.datatable)) {
        sources.kickStale(req.datatable, { reason: 'view' });
    }
}

/**
 * ONE row. The access filter is ANDed in, so a row the caller may not see
 * returns 0 rows and reads as 404, the same rule the whole surface follows.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 */
async function getRow(req, res) {
    const { meta, filter } = await metaAndFilter(req, 'read');
    const { sql, params } = queryCompiler.compileGetById(meta, req.params.rowId, filter, PG);
    const out = await datatableDbStore.query(
        req.datatableScopeKey, req.datatableScopeKey, sql, params);
    const row = (out.rows || [])[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ row });
}

/** @param {DatatableRequest} req @param {import('express').Response} res */
async function insertRow(req, res) {
    const meta = await metaFor(req);
    accessFilter.assertCanWrite(meta, req.datatableGrade, 'create');
    // A locked reference table refuses before the quota is read: "the rows are
    // the release's" is the answer, not "the table is full". Also covers a
    // mirror, which never reaches compileInsert below.
    queryCompiler.assertRowsWritable(meta);
    await assertQuota(req, { addRows: 1 });
    // A mirror's row goes to the source first; the copy is written from what
    // the source answered (core/dataEngine/sources).
    if (sources.isSourceMirror(req.datatable)) {
        const r = await mirrorWrites().insertRow(mirrorCtx(req, meta), req.body.values);
        return res.json({ ok: true, id: r.id });
    }
    const { sql, params, id } = queryCompiler.compileInsert(meta, req.body.values, {
        createdBy: req.datatablePrincipal.userId,
        // NULL on a personal table, and correct: `org_id` records which
        // organisation the row belongs to, and a personal row belongs to none.
        // Inventing one here would make the row look shared.
        orgId: req.datatable.organizationId,
        dialect: 'pg',
    });
    await datatableDbStore.exec(
        req.datatableScopeKey, req.datatableScopeKey, sql, params);
    await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, 1);
    // The id compileInsert minted, so the caller can address the row it just
    // added without re-reading the page to find it.
    res.json({ ok: true, id });
}

/**
 * EDIT a row. `expectedUpdatedAt` is required (see rows.js): 400 when it is
 * absent, 409 `row_conflict` when it is stale, and the two are told apart by
 * re-reading the row: "changed under you" and "gone / not yours" need
 * different answers.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 */
async function updateRow(req, res) {
    const { meta, filter } = await metaAndFilter(req, 'update');
    accessFilter.assertCanWrite(meta, req.datatableGrade, 'update');
    const { values, expectedUpdatedAt } = req.body;

    // Same three answers as below (404, 409 row_conflict, {row}) with the
    // source asked in between.
    if (sources.isSourceMirror(req.datatable)) {
        const r = await mirrorWrites().updateRow(mirrorCtx(req, meta), req.params.rowId, values, { expectedUpdatedAt });
        if (!r.changes) {
            if (!r.row) return res.status(404).json({ error: 'Not found' });
            return res.status(409).json(conflictBody(r.row));
        }
        return res.json({ row: r.row });
    }

    const upd = queryCompiler.compileUpdate(meta, req.params.rowId, values, filter,
        { expectedUpdatedAt, dialect: 'pg' });
    const out = await datatableDbStore.exec(
        req.datatableScopeKey, req.datatableScopeKey, upd.sql, upd.params);

    // Read it back either way: on success the caller needs the new updated_at
    // for its NEXT edit, and on failure the row itself is the difference
    // between "somebody else changed it" and "it is not there".
    const probe = queryCompiler.compileGetById(meta, req.params.rowId, filter, PG);
    const found = await datatableDbStore.query(
        req.datatableScopeKey, req.datatableScopeKey, probe.sql, probe.params);
    const row = (found.rows || [])[0] || null;

    if (!out?.changes) {
        if (!row) return res.status(404).json({ error: 'Not found' });
        return res.status(409).json(conflictBody(row));
    }
    // data_version moves, row_count does not: an edit adds no rows.
    await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, 0);
    res.json({ row });
}

/** @param {DatatableRequest} req @param {import('express').Response} res */
async function deleteRow(req, res) {
    const { meta, filter } = await metaAndFilter(req, 'delete');
    accessFilter.assertCanWrite(meta, req.datatableGrade, 'delete');
    if (sources.isSourceMirror(req.datatable)) {
        const r = await mirrorWrites().deleteRow(mirrorCtx(req, meta), req.params.rowId);
        if (!r.changes) return res.status(404).json({ error: 'Not found' });
        // A row-number mirror renumbers every row below the one that went; the
        // client reloads on this flag instead of trusting its list.
        return res.json({ ok: true, ...(r.renumbered ? { renumbered: true } : {}) });
    }
    const { sql, params } = queryCompiler.compileDelete(meta, req.params.rowId, filter, PG);
    const out = await datatableDbStore.exec(
        req.datatableScopeKey, req.datatableScopeKey, sql, params);
    // The access filter is ANDed into the statement, so "nothing changed"
    // covers both a row that never existed and one this caller may not see:
    // 404 either way, and no counter move. Decrementing unconditionally is
    // what let N deletes of nothing walk row_count down to 0 on a full table:
    // GREATEST(0, …) hides the underflow and the quota then passes forever.
    if (!out?.changes) return res.status(404).json({ error: 'Not found' });
    await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, -1);
    res.json({ ok: true });
}

/**
 * A selection deleted at a mirror's source: in one write where the source has one.
 * @param {DatatableRequest} req
 * @param {Awaited<ReturnType<typeof metaFor>>} meta
 * @param {string[]} ids
 */
async function deleteAtSource(req, meta, ids) {
    const wt = sources.writeThrough(req.datatable);
    const ctx = mirrorCtx(req, meta);
    let gone = 0;
    let renumbered = false;
    if (typeof wt.deleteRows === 'function') {
        // The spreadsheet write-through adds `renumbered` (spreadsheetFile/writeThrough.js).
        const r = /** @type {Awaited<ReturnType<typeof wt.deleteRows>> & { renumbered?: boolean }} */ (await wt.deleteRows(ctx, ids));
        gone = r.changed;
        renumbered = !!r.renumbered;
    } else {
        for (const id of ids) {
            const r = /** @type {Awaited<ReturnType<typeof wt.deleteRow>> & { renumbered?: boolean }} */ (await wt.deleteRow(ctx, id));
            gone += r.changes;
            renumbered = renumbered || !!r.renumbered;
        }
    }
    return { deleted: gone, requested: ids.length, ...(renumbered ? { renumbered: true } : {}) };
}

/**
 * A selection, deleted in ONE transaction (see rows.js): the single delete's
 * compiled statement N times, all-or-nothing, the counter moved by what
 * Postgres reports gone.
 * @param {DatatableRequest} req
 * @param {import('express').Response} res
 */
async function bulkDelete(req, res) {
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
    if (sources.isSourceMirror(req.datatable)) return res.json(await deleteAtSource(req, meta, ids));

    const statements = ids.map(id => queryCompiler.compileDelete(meta, id, filter, PG));
    const results = await datatableDbStore.batch(req.datatableScopeKey, req.datatableScopeKey,
        statements.map(c => ({ sql: c.sql, params: c.params })));
    const deleted = results.reduce((/** @type {number} */ n, /** @type {{ changes: unknown; }} */ r) => n + (Number(r?.changes) || 0), 0);
    // Same rule as the single delete: the counter moves by what really went,
    // never by what was asked, or N deletes of nothing walk it to 0.
    if (deleted > 0) await datatableStore.bumpAfterWrite(req.datatable.id, req.datatableScope, -deleted);
    res.json({ deleted, requested: ids.length });
}

module.exports = {
    answering,
    listRows: answering(listRows),
    getRow: answering(getRow),
    insertRow: answering(insertRow),
    updateRow: answering(updateRow),
    deleteRow: answering(deleteRow),
    bulkDelete: answering(bulkDelete),
};
