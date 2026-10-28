/**
 * App Studio — the shared READ runner.
 *
 * One implementation of "run a read against an app's data", used by every
 * surface that serves one:
 *
 *   routes/studioAppData.js    GET  /:id/data/tables/:tableId/records
 *                              POST /:id/data/query
 *                              POST /:id/data/batch          <- new
 *   routes/studioAppPublic.js  GET  /:token/data/tables/:tableId/records
 *                              POST /:token/data/query
 *                              POST /:token/data/batch       <- new
 *
 * WHY IT EXISTS. Batching adds a second door onto the same data, and the one
 * thing that must never differ between two doors is who may walk through. The
 * table lookup, the `canRead` gate, the compiled access filter and the
 * owner-scoped DB handle all live here exactly once, so a batched read cannot
 * drift from the single read it replaces. A table lookup copied into each
 * router would be one more place for the RLS gate beside it to be forgotten.
 *
 * WHAT STAYS IN THE ROUTERS. Everything about the REQUEST rather than the
 * read: session/visitor auth, app visibility, the rate limiters, the
 * `sys_org_members` platform dataset (an org directory, not app data), and
 * `kickStaleSync` (a response-time side effect the public surface deliberately
 * does not have).
 *
 * ERRORS. Every refusal is an Error carrying `status` + `safe: true`. `safe`
 * is what lets a router hand the message to the client verbatim: these strings
 * ('Table not found', 'Forbidden', ...) are the ones the routes already
 * answered with, and the flag is set in exactly one place (./readError.js), so
 * an internal message cannot ride out on it by accident.
 *
 * TWO KINDS OF TABLE. A model table either owns its rows itself (the kind that
 * always existed: the per-app database, `ctx.ownerScope` + `ctx.app.id`), or it
 * fetches them from a STUDIO DATATABLE (`table.source = {kind:'datatable', …}`).
 * That difference is made in ONE place — `readPlan` below — and nowhere else in
 * this file: every read after that compiles with the same access filter, the same
 * compiler and the same cursor handling. The permission decision for the second
 * kind is in ./datatableSource.js; that one is fundamentally different (the
 * datatable has its own ladder, outside the app) and therefore does not belong here.
 */

const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const datasetCache = require('./datasetCache');
const studioAppDbStore = require('../stores/studioAppDbStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const datatableSource = require('./datatableSource');
const { readError } = require('./readError');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

/**
 * A table reference is either an id (tbl_xxx) or a key (tasks) — authors write
 * both, and every caller has always accepted both.
 */
function findTable(model, ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const tables = Array.isArray(model && model.tables) ? model.tables : [];
    return tables.find((t) => t && (t.id === ref || t.key === ref)) || null;
}

/**
 * The gate every read passes: the table exists AND this viewer's role may read
 * it. Kept as one function because the 404 and the 403 belong together — a
 * caller that checks only the first has written an access-control hole that
 * looks like ordinary code.
 */
function requireReadableTable(ctx, ref) {
    const table = findTable(ctx.model, ref);
    if (!table) throw readError(404, 'Table not found');
    if (!rlsGateway.canRead(table, ctx.role)) throw readError(403, 'Forbidden');
    return table;
}

/**
 * WHERE the rows of this table are stored, and with which rights they are read —
 * the only place in this file where the two kinds of table part ways.
 *
 * Delivers the same four things for both, so that everything AFTER this function stays
 * one implementation: the table description for the compiler, the role with which the
 * access filter is compiled, the viewer that filter binds against, and the dialect. The
 * storage itself sits in `query`.
 *
 * The app's OWN storage keeps exactly the behaviour it had: `dialect: undefined` lets
 * resolveDialect fall through to the process-wide STUDIO_APP_ENGINE, exactly as leaving
 * out the option did.
 *
 * MEMOISED PER CONTEXT, no longer. A batch reads up to 25 descriptors with one ctx and
 * would otherwise fetch the table, the grants and two principals from the database again
 * per descriptor. A ctx lives for one request, so this has the same lifetime as
 * `req._dtPrincipal` in auth/datatableAccess — and explicitly NOT a grade that a next read
 * survives (core/automationRunner/datatableResolve.js, refusal 2). What is kept is the
 * PROMISE, not the result: a refusal then holds for all 25, exactly as it held for the first.
 */
function readPlan(ctx, table) {
    if (!datatableSource.isDatatableBacked(table)) {
        return Promise.resolve({
            tableMeta: table,
            role: ctx.role,
            viewer: ctx.viewer,
            dialect: undefined,
            query: (sql, params) => studioAppDbStore.query(ctx.ownerScope, ctx.app.id, sql, params),
        });
    }
    if (!ctx._datatablePlans) ctx._datatablePlans = new Map();
    const key = table.id || table.key;
    if (!ctx._datatablePlans.has(key)) {
        ctx._datatablePlans.set(key, datatableSource.resolveDatatableRead(ctx, table).then((resolved) => {
            // A linked table that MIRRORS an EXTERNAL SOURCE: someone looks at it, so refresh
            // the copy in the background if it is older than its schema (stale-while-serve).
            // Once per request — this plan is memoised per ctx — and never affecting the
            // answer. The register answers `false` for an ordinary table, so the question
            // need not be asked here.
            try {
                require('../core/dataEngine/sources').kickStale(resolved.datatable, { reason: 'view' });
            } catch (err) { bestEffort('appStudio/dataReadRunner:readPlan', err); /* a background refresh is never a reason to fail a read */ }
            return resolved;
        }).then((resolved) => ({
            tableMeta: resolved.tableMeta,
            // The GRADE is the role here: the access block comes from the datatable
            // (synthesizeAccess), not from the app.
            role: resolved.grade,
            viewer: resolved.viewer,
            dialect: resolved.dialect,
            query: (sql, params) => {
                const datatableDbStore = require('../stores/datatableDbStore');
                // ownerId and entityId are BOTH the SCOPE key — the unit of storage is the scope,
                // not one table (stores/datatableDbStore.js).
                return datatableDbStore.query(resolved.scopeKey, resolved.scopeKey, sql, params);
            },
        })));
    }
    return ctx._datatablePlans.get(key);
}

/**
 * A page of records, keyset-paginated.
 *
 * The compiler asks for limit+1 rows so "is there a next page" needs no second
 * query; trimming that extra row and minting the cursor is this function's job
 * and must not be copied into each router.
 */
async function runRecordList(ctx, table, { filters, sort, cursor, limit } = {}) {
    const plan = await readPlan(ctx, table);
    const accessFilter = rlsGateway.compileAccessFilter(plan.tableMeta, plan.role, plan.viewer, 'read', { dialect: plan.dialect });
    const compiled = queryCompiler.compileRecordList(plan.tableMeta, { filters, sort, cursor, limit, dialect: plan.dialect }, accessFilter);
    const { rows } = await plan.query(compiled.sql, compiled.params);

    let nextCursor = null;
    if (rows.length > compiled.limit) {
        const last = rows[compiled.limit - 1];
        rows.length = compiled.limit;
        nextCursor = queryCompiler.encodeCursor(last[compiled.primaryField], last.id);
    }
    return { records: rows, nextCursor };
}

/** An inline aggregate descriptor — a count/sum/group-by with no saved dataset. */
async function runInlineAggregate(ctx, table, descriptor = {}) {
    const plan = await readPlan(ctx, table);
    const accessFilter = rlsGateway.compileAccessFilter(plan.tableMeta, plan.role, plan.viewer, 'read', { dialect: plan.dialect });
    const { sql, params } = queryCompiler.compileAggregate(plan.tableMeta, {
        filters: descriptor.filters,
        groupBy: descriptor.groupBy,
        aggregates: descriptor.aggregates,
        sort: descriptor.sort,
        limit: descriptor.limit,
        dialect: plan.dialect,
    }, accessFilter);
    const { rows } = await plan.query(sql, params);
    return { rows };
}

/**
 * A saved dataset, served through the memoising runner.
 *
 * The dataset row is OWNER-scoped (getDataset gates on it) while the access
 * filter runDataset builds is VIEWER-scoped — that split is the whole reason a
 * cached dataset is safe to share between viewers, and it is preserved here
 * unchanged.
 */
async function runSavedDataset(ctx, datasetId, { refresh = false } = {}) {
    const dataset = studioAppDataStore.getDataset
        ? await studioAppDataStore.getDataset(datasetId, ctx.app.id, ctx.app.userId)
        : null;
    if (!dataset) throw readError(404, 'Dataset not found');
    const table = requireReadableTable(ctx, dataset.tableId);
    // A saved dataset runs through datasetCache, and that talks directly to the app's own
    // database (studioAppDbStore). A table that fetches its rows from a Studio datatable does
    // not exist there — the read would give not rows but an SQL error, and in a batch a
    // status 500 that reads as "broken server" instead of "this cannot be done yet". So it
    // says here what is going on, until the dataset cache knows the same split.
    if (datatableSource.isDatatableBacked(table)) {
        throw readError(501, 'A saved dataset cannot read a linked Studio table yet.');
    }
    const out = await datasetCache.runDataset(ctx.app, ctx.model, dataset, ctx.viewer, { refresh });
    return { rows: out.rows, columns: out.columns, truncated: out.truncated, cached: out.cached };
}

// ── Batch descriptors ───────────────────────────────────────────────

/** The read kinds a batch may carry. Connectors are absent on purpose. */
const BATCH_READ_KINDS = new Set(['records', 'aggregate', 'dataset']);

/**
 * Run ONE descriptor from a batch and answer in the same shape the dedicated
 * endpoint does, so the client can parse a batched answer with the code it
 * already uses for a single one.
 *
 * Connectors are not a read: they run server-side against a third party, live
 * on another router behind another limiter, and can have side effects. A batch
 * that carried them would quietly turn "load this screen" into "call five
 * external APIs in one request", so the kind is simply not in the vocabulary.
 *
 * Returns `{ table }` alongside the payload so the caller can do its own
 * response-time work (the authenticated router kicks a connector refresh for
 * tables it just read); a caller that does not care ignores it.
 */
async function runBatchRead(ctx, read) {
    const kind = read && typeof read.kind === 'string' ? read.kind : '';
    if (!BATCH_READ_KINDS.has(kind)) throw readError(400, 'Unsupported read kind');

    if (kind === 'dataset') {
        const datasetId = read.datasetId;
        if (typeof datasetId !== 'string' || !datasetId) throw readError(400, 'datasetId is required');
        // `sys_*` ids belong to the PLATFORM, not to the app's dataset table —
        // sys_org_members is the organisation's member directory, intercepted
        // by /data/query before it ever reaches a lookup. Refused as a 400
        // rather than left to fall through: getDataset would answer a truthful
        // 404, the client degrades a 404 to "empty", and a people-picker that
        // silently shows nobody is worse than one that says it cannot load.
        if (datasetId.startsWith('sys_')) throw readError(400, 'Platform datasets are not available in a batch');
        const out = await runSavedDataset(ctx, datasetId, { refresh: false });
        // `result` mirrors the dataset-binding contract the runtime reads.
        return { payload: { ...out, result: out.rows }, table: null };
    }

    const table = requireReadableTable(ctx, read.tableId);
    if (kind === 'aggregate') {
        return { payload: await runInlineAggregate(ctx, table, read), table };
    }
    return {
        payload: await runRecordList(ctx, table, {
            filters: read.filters,
            sort: read.sort,
            cursor: read.cursor,
            limit: read.limit,
        }),
        table,
    };
}

/**
 * Run a whole batch. Never rejects on a descriptor's account: one bad table
 * reference must not blank the other eleven components on the screen, so each
 * read answers for itself and the transport-level result is always a success.
 *
 * A refusal is reported with the status the dedicated endpoint would have
 * used, because the client's fail-soft rules key off exactly that (a 404 on a
 * records read degrades to an empty list, as it always has).
 */
async function runBatch(ctx, reads, { onTable } = {}) {
    const results = [];
    for (const read of Array.isArray(reads) ? reads : []) {
        const id = read && typeof read.id === 'string' ? read.id : null;
        if (!id) {
            // Unaddressable: the client could not match it to a binding anyway.
            results.push({ id: null, ok: false, status: 400, error: 'Each read needs an id' });
            continue;
        }
        try {
            const { payload, table } = await runBatchRead(ctx, read);
            if (table && typeof onTable === 'function') onTable(table);
            results.push({ id, ok: true, data: payload });
        } catch (err) {
            const status = err && err.safe === true && typeof err.status === 'number' ? err.status : 500;
            results.push({
                id,
                ok: false,
                status,
                error: status === 500 ? 'Data request failed' : err.message,
            });
            if (status === 500) log.error(`[DataReadRunner/batch] ${err && err.message}`);
        }
    }
    return results;
}

module.exports = {
    readError,
    findTable,
    requireReadableTable,
    readPlan,
    runRecordList,
    runInlineAggregate,
    runSavedDataset,
    runBatchRead,
    runBatch,
    BATCH_READ_KINDS,
};

/**
 * @typedef {import('./actionExecutor/shared').DataModel} DataModel
 * @typedef {import('./actionExecutor/shared').DataTable} DataTable
 * @typedef {{ rows: Array<Record<string, any>>, columns?: unknown[], truncated?: boolean }} QueryResult  raw database rows
 * @typedef {{ tableMeta: DataTable, role: string | null | undefined, viewer: Record<string, unknown> | undefined, dialect: string | undefined, query: (sql: string, params: unknown[]) => Promise<QueryResult> }} ReadPlan  where a table's rows live and under which rights
 * @typedef {object} ReadCtx  the per-request context of a read
 * @property {DataModel} model
 * @property {string | null} [role]
 * @property {Record<string, unknown>} [viewer]
 * @property {string | null} [viewerId]
 * @property {{ id: string, userId: string, organizationId?: string | null }} app
 * @property {string} ownerScope
 * @property {Map<string, Promise<ReadPlan>>} [_datatablePlans]
 * @typedef {{ id?: unknown, kind?: unknown, datasetId?: unknown, tableId?: unknown, filters?: unknown, groupBy?: unknown, aggregates?: unknown, sort?: unknown, cursor?: string | null, limit?: unknown }} BatchRead  one descriptor of a batch
 */
