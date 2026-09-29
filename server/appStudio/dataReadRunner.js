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
 * drift from the single read it replaces. Before this, the table lookup was
 * written out six times across two routers — six places for the RLS gate
 * beside it to be forgotten.
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
 * TWEE TABELSOORTEN. Een modeltabel bezit haar rijen zelf (de soort die er
 * altijd was: de per-app database, `ctx.ownerScope` + `ctx.app.id`) of ze haalt
 * ze uit een STUDIO-DATATABEL (`table.source = {kind:'datatable', …}`). Dat
 * verschil wordt op ÉÉN plek gemaakt — `readPlan` hieronder — en verder in dit
 * bestand nergens meer: elke lezing compileert daarna met dezelfde
 * access-filter, dezelfde compiler en dezelfde cursorbehandeling. De
 * rechtenbeslissing voor de tweede soort staat in ./datatableSource.js; die is
 * wezenlijk anders (de datatabel heeft zijn eigen ladder, buiten de app om) en
 * hoort daarom niet hier.
 */

const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const datasetCache = require('./datasetCache');
const studioAppDbStore = require('../stores/studioAppDbStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const datatableSource = require('./datatableSource');
const { readError } = require('./readError');
const log = require('../telemetry/log');

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
 * WAAR de rijen van deze tabel staan, en met welke rechten ze gelezen worden —
 * de enige plek in dit bestand waar de twee tabelsoorten uit elkaar gaan.
 *
 * Levert voor allebei dezelfde vier dingen, zodat alles ná deze functie één
 * implementatie blijft: de tabelbeschrijving voor de compiler, de rol waarmee de
 * access-filter wordt gecompileerd, de viewer waar die filter tegen bindt, en de
 * dialect. De opslag zelf zit in `query`.
 *
 * De EIGEN opslag van de app houdt exact het gedrag dat het had: `dialect:
 * undefined` laat resolveDialect bij de procesbrede STUDIO_APP_ENGINE uitkomen,
 * precies zoals het weglaten van de optie dat deed.
 *
 * GEMEMOÏSEERD PER CONTEXT, niet langer. Een batch leest tot 25 descriptors met
 * één ctx en zou anders per descriptor opnieuw de tabel, de grants en twee
 * principalen uit de database halen. Een ctx leeft één request, dus dit is
 * dezelfde houdbaarheid als `req._dtPrincipal` in auth/datatableAccess — en
 * nadrukkelijk NIET een graad die een volgende lezing overleeft
 * (core/automationRunner/datatableResolve.js, weigering 2). De belofte wordt
 * bewaard, niet het resultaat: een weigering geldt dan voor alle 25, precies
 * zoals hij voor de eerste gold.
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
            // Een gekoppelde tabel die een EXTERNE BRON spiegelt: iemand
            // kijkt ernaar, dus ververs de kopie op de achtergrond als hij
            // ouder is dan zijn schema (stale-while-serve). Eén keer per
            // request — dit plan is per ctx gememoiseerd — en nooit van
            // invloed op het antwoord. Het register antwoordt `false` voor
            // een gewone tabel, dus de vraag hoeft hier niet gesteld.
            try {
                require('../core/dataEngine/sources').kickStale(resolved.datatable, { reason: 'view' });
            } catch (_) { /* a background refresh is never a reason to fail a read */ }
            return resolved;
        }).then((resolved) => ({
            tableMeta: resolved.tableMeta,
            // De GRAAD is hier de rol: het access-blok komt van de datatabel
            // (synthesizeAccess), niet van de app.
            role: resolved.grade,
            viewer: resolved.viewer,
            dialect: resolved.dialect,
            query: (sql, params) => {
                const datatableDbStore = require('../stores/datatableDbStore');
                // ownerId én entityId zijn allebei de SCOPE-sleutel — de eenheid
                // van opslag is de scope, niet één tabel (stores/datatableDbStore.js).
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
 * and used to be copied into each router.
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
    // Een opgeslagen dataset draait door datasetCache, en die praat rechtstreeks
    // met de app-eigen database (studioAppDbStore). Een tabel die haar rijen uit
    // een Studio-datatabel haalt, bestaat daar niet — de lezing zou geen rijen
    // maar een SQL-fout opleveren, en in een batch een status 500 die als
    // "kapotte server" leest in plaats van als "dit kan nog niet". Dus zegt hij
    // hier wat er aan de hand is, tot de datasetcache dezelfde splitsing kent.
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
