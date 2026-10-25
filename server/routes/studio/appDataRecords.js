// @typecheck
/**
 * App Studio data routes: the tables and their records (list, read, create,
 * update, delete), every statement through the viewer's access filter.
 * The route table stays in routes/studioAppData.js. Split out of it;
 * behaviour unchanged.
 */

const rlsGateway = require('../../appStudio/rlsGateway');
const actionExecutor = require('../../appStudio/actionExecutor');
const dataReadRunner = require('../../appStudio/dataReadRunner');
const {
    handleErr, resolveDataContext, publicTable, parseListQuery, kickStaleSync, LINK_REFUSED, linkedTableFlags, readOne,
} = require('./appDataContext');
const { fallback } = require('../../utils/bestEffort');

// GET /:id/data/tables — tables the viewer may READ (fields only).
/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function listTables(req, res) {
    try {
        const ctx = await resolveDataContext(req, res);
        if (!ctx) return;
        const tables = [];
        for (const t of ctx.model.tables) {
            if (!rlsGateway.canRead(t, ctx.role)) continue;
            const flags = await linkedTableFlags(ctx, t);
            if (flags === LINK_REFUSED) continue;
            tables.push({ ...publicTable(t), .../** @type {{ linked: boolean, readOnly: boolean } | null} */ (flags) });
        }
        res.json({ tables });
    } catch (err) { handleErr(res, err, 'tables'); }
}

// GET /:id/data/tables/:tableId/records — list.
/**
 * @param {import('express').Request<{ id: string, tableId: string }, any, any, import('qs').ParsedQs & { cursor?: string, limit?: number }>} req  query as validated by RecordsQuery
 * @param {import('express').Response} res
 */
async function listRecords(req, res) {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        if (!rlsGateway.canRead(ctx.table, ctx.role)) return res.status(403).json({ error: 'Forbidden' });

        const { filters, sort } = parseListQuery(req);
        const { records, nextCursor } = await dataReadRunner.runRecordList(ctx, ctx.table, {
            filters, sort, cursor: req.query.cursor, limit: req.query.limit,
        });
        // appVersion rides along on the read every screen already makes: a
        // viewer whose session predates a republish learns about it without a
        // single extra request.
        res.json({ records, nextCursor, appVersion: ctx.app.publishedVersion ?? null });
        // AFTER the response: a connector-filled table refreshes itself when
        // someone looks at stale data, so an app nobody opens costs no API quota.
        kickStaleSync(ctx);
    } catch (err) { handleErr(res, err, 'records.list'); }
}

// POST /:id/data/tables/:tableId/records — create.
/**
 * @param {import('express').Request<{ id: string, tableId: string }>} req
 * @param {import('express').Response} res
 */
async function createRecord(req, res) {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;

        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const values = (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) ? body.values : body;

        // writeRecord is the single record-write choke point: RLS (403), row +
        // byte quotas (409), compileInsert, exec acts-as-owner, version/row-count
        // bumps. created_by is the SESSION user; org_id is the app's org — any
        // such keys in `values` are dropped by the compiler.
        const { id } = await actionExecutor.writeRecord(ctx.app, ctx.model, ctx.table, values, { viewer: ctx.viewer });

        const record = await readOne(ctx, id).catch((e) => fallback('routes/studio/appDataRecords:createRecord', e, null));
        res.json({ success: true, id, record });
    } catch (err) { handleErr(res, err, 'records.create'); }
}

// GET /:id/data/tables/:tableId/records/:recordId — read one.
/**
 * @param {import('express').Request<{ id: string, tableId: string, recordId: string }>} req
 * @param {import('express').Response} res
 */
async function getRecord(req, res) {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        if (!rlsGateway.canRead(ctx.table, ctx.role)) return res.status(403).json({ error: 'Forbidden' });
        const record = await readOne(ctx, req.params.recordId);
        if (!record) return res.status(404).json({ error: 'Record not found' });
        res.json({ record });
    } catch (err) { handleErr(res, err, 'records.get'); }
}

// PATCH /:id/data/tables/:tableId/records/:recordId — update.
/**
 * @param {import('express').Request<{ id: string, tableId: string, recordId: string }>} req
 * @param {import('express').Response} res
 */
async function updateRecord(req, res) {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;

        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        // `expectedUpdatedAt` is an ENVELOPE field, never a column: strip it
        // from the bare-body form too, or the compiler would reject it as an
        // unknown field the moment a caller omits `values`.
        const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt
            ? body.expectedUpdatedAt
            : null;
        let values;
        if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
            values = body.values;
        } else {
            const { expectedUpdatedAt: _envelope, ...rest } = body;
            values = rest;
        }

        // Same choke point, update path: RLS (403), byte quota only (409), the
        // viewer's access filter ANDed into the WHERE — 0 rows = missing OR
        // out-of-scope, answered as a uniform 404.
        const { changes } = await actionExecutor.writeRecord(ctx.app, ctx.model, ctx.table, values, {
            viewer: ctx.viewer,
            recordId: req.params.recordId,
            expectedUpdatedAt,
        });
        if (!changes) {
            // With a CAS token, 0 rows has two very different meanings. Re-read
            // under the viewer's own access filter: still visible ⇒ somebody
            // else wrote it first (409 + the CURRENT row so the UI can show or
            // merge it); invisible ⇒ gone or out of scope, the uniform 404 that
            // never reveals which.
            if (expectedUpdatedAt) {
                const current = await readOne(ctx, req.params.recordId).catch((e) => fallback('routes/studio/appDataRecords:updateRecord', e, null));
                if (current) {
                    return res.status(409).json({
                        error: 'This record was changed by someone else — reload and try again.',
                        code: 'record_conflict',
                        record: current,
                    });
                }
            }
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = await readOne(ctx, req.params.recordId).catch((e) => fallback('routes/studio/appDataRecords:updateRecord#2', e, null));
        res.json({ success: true, record });
    } catch (err) { handleErr(res, err, 'records.update'); }
}

// DELETE /:id/data/tables/:tableId/records/:recordId — delete.
/**
 * @param {import('express').Request<{ id: string, tableId: string, recordId: string }>} req
 * @param {import('express').Response} res
 */
async function deleteRecord(req, res) {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        // eraseRecord is the DELETE choke point: RLS (403), the second kind of
        // table, the access filter in the WHERE and the bookkeeping after it.
        // Deletes stay quota-free — that is the way out by which a full app can
        // shrink. This route used to compile it itself and so did not know the
        // linked table: `DELETE FROM \"klanten\"` on the app storage, 404 on a
        // row that sits right there in the datatable, and on a table that once
        // HAD its own storage the silent wipe of the old shadow rows.
        const { changes } = await actionExecutor.eraseRecord(
            ctx.app, ctx.model, ctx.table, req.params.recordId, { viewer: ctx.viewer });
        if (!changes) return res.status(404).json({ error: 'Record not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'records.delete'); }
}

module.exports = { listTables, listRecords, createRecord, getRecord, updateRecord, deleteRecord };
