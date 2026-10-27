// @typecheck noImplicitAny
/**
 * The steps of ONE FULL PASS over a mirror, for ./syncPipeline.js (which
 * documents the order — it is the correctness — and the adapter contract).
 * Each function is one numbered step there; runPass runs 2 to 11 after the
 * claim, and recordFailure is what a failure leaves on `sync_state`.
 *
 * `./schema` and `./relations` are required by those names on purpose: the
 * engine unit tests stub them by request string, and a stub keyed on the
 * string matches whichever file asks.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const { synthesizeAccess } = require('../../../../auth/datatableAccess');
const { assertDatatableQuota } = require('../../datatableLimits');
const { reconcileMirrorSchema } = require('./schema');
const { buildRelationIndexes } = require('./relations');
const { fieldsByIdOf } = require('./rows');
const { ownerFilter } = require('./access');
const { isSourceError } = require('./errors');
const staleness = require('./staleness');
const C = require('./constants');
const log = require('../../../../telemetry/log');
const { fallback } = require('../../../../utils/bestEffort');

/** @typedef {NonNullable<ReturnType<typeof import('../../../../stores/datatableStore/rowMappers').rowToDatatable>>} MirrorRow */
/** @typedef {import('./syncPipeline').MirrorSiblings} MirrorSiblings */
/** @typedef {Awaited<ReturnType<typeof datatableStore.getTableMeta>>} MirrorMeta */
/** What `adapter.rowFromSource` is handed. @typedef {{ columnMap?: unknown, fieldsById?: unknown, relationIndexes?: unknown, labelIndexes?: unknown, source?: unknown }} RowCtx */
/**
 * What `adapter.open` answers (see ./syncPipeline.js "THE ADAPTER").
 * @typedef {{ unchanged?: boolean, statePatch?: Record<string, unknown>, columns?: unknown,
 *             page?: (limit: number, offset: number) => Promise<unknown[]>, warnings?: string[], truncated?: boolean }} OpenedSource
 */
/**
 * What `adapter.deriveFields` answers.
 * @typedef {{ fields: Parameters<typeof reconcileMirrorSchema>[2], columnMap?: unknown, relations?: unknown[], warnings?: string[],
 *             changes: string[], retyped?: Parameters<typeof reconcileMirrorSchema>[3]['retyped'], sourcePatch?: Record<string, unknown> }} DerivedColumns
 */
/**
 * The adapter members one pass calls (the contract is in ./syncPipeline.js).
 * @typedef {{ resolveLinker: (source: MirrorRow['source'], opts: { orgId: string | null }) => Promise<{ auth?: unknown }>,
 *             apiFor: (auth: unknown, source: MirrorRow['source']) => unknown,
 *             siblingsOf: (scope: MirrorRow['scope']) => Promise<MirrorSiblings>,
 *             open: (api: unknown, table: MirrorRow, opts: { prev: Record<string, unknown>, mustFetch: boolean, rowCap: number }) => Promise<OpenedSource>,
 *             deriveFields: (columns: unknown, ctx: { existingFields?: unknown[], siblings?: unknown, declaredRelations?: unknown[], source?: unknown }) => DerivedColumns | Promise<DerivedColumns>,
 *             rowFromSource: (raw: unknown, ctx: RowCtx) => { id: unknown, values: object } | null,
 *             labelFieldFor?: Parameters<typeof buildRelationIndexes>[2]['labelFieldFor'] }} PassAdapter
 */
/** @typedef {{ prev: Record<string, any>, schedule: Parameters<typeof staleness.nextRunAtFor>[0], reason: string, startedAt: number, warnings: string[] }} FinishCtx */

/**
 * The declared (match) relations, with what the adapter needs to name their column.
 * @param {{ relations?: Array<{ kind?: string, targetDatatableId?: string, [k: string]: unknown }> } | null | undefined} source
 * @param {MirrorSiblings} siblings
 */
function declaredOf(source, siblings) {
    return ((source && source.relations) || [])
        .filter(r => r && r.kind === 'match')
        .map((r) => {
            const target = /** @type {{ id: string, key?: string, name?: string } | undefined} */ (siblings.byId.get(r.targetDatatableId));
            return { ...r, targetKey: target ? target.key : null, targetName: target ? target.name : null };
        });
}

/**
 * ── 3. columns ── Bring the mirror's field list in step with the source's
 * columns. Returns the (possibly new) table and meta, and what changed.
 * @param {PassAdapter} adapter
 * @param {MirrorRow} table
 * @param {unknown} columns
 * @param {MirrorSiblings} siblings
 * @param {MirrorMeta} meta
 */
async function reconcileColumns(adapter, table, columns, siblings, meta) {
    const scope = table.scope;
    const source = table.source;
    const derived = await adapter.deriveFields(columns, {
        existingFields: (meta && meta.fields) || [],
        siblings,
        declaredRelations: declaredOf(source, siblings),
        source,
    });
    let nextMeta = meta;
    if (derived.changes.length || !meta) {
        await reconcileMirrorSchema(scope, table, derived.fields, { retyped: derived.retyped || [] });
        nextMeta = await datatableStore.getTableMeta(scope, table.id);
    }
    // Options, titles and relation targets can move without a field moving;
    // the source block is rewritten whenever it differs. The adapter's
    // `sourcePatch` rides along (see the header).
    const nextSource = { ...source, columnMap: derived.columnMap, relations: derived.relations, ...(derived.sourcePatch || {}) };
    let updated = table;
    if (JSON.stringify(nextSource) !== JSON.stringify(source)) {
        updated = await datatableStore.setSource(table.id, scope, nextSource) || table;
    }
    return { table: updated, meta: nextMeta, changes: derived.changes, warnings: derived.warnings || [] };
}

/**
 * The state fields of every successful finish.
 * @param {FinishCtx['schedule']} schedule
 * @param {string} reason
 * @param {number} startedAt
 */
function okState(schedule, reason, startedAt) {
    const now = new Date();
    return {
        status: 'ok',
        lastSyncAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        nextRunAt: staleness.nextRunAtFor(schedule, now.getTime(), 0),
        lastError: /** @type {string | null} */ (null),
        lastErrorCode: /** @type {string | null} */ (null),
        consecutiveErrors: 0,
        lastReason: reason,
        durationMs: Date.now() - startedAt,
    };
}

/**
 * ── 2b. "unchanged" ── the probe found nothing: no snapshot, no batch, no counter.
 * @param {MirrorRow} table
 * @param {OpenedSource} opened
 * @param {FinishCtx} ctx
 */
async function finishUnchanged(table, opened, { schedule, reason, startedAt, prev, warnings }) {
    const ok = okState(schedule, reason, startedAt);
    const state = await datatableStore.finishSourceSync(table.id, {
        status: ok.status, lastSyncAt: ok.lastSyncAt, lastSuccessAt: ok.lastSuccessAt, nextRunAt: ok.nextRunAt,
        lastError: null, lastErrorCode: null, consecutiveErrors: 0,
        written: 0, deleted: 0, staleReason: null, lastReason: reason, durationMs: ok.durationMs,
        skipped: 'unchanged',
        ...(opened.statePatch || {}),
    });
    return { ok: true, unchanged: true, syncState: state ? state.syncState : null, warnings, written: 0, deleted: 0, rowCount: Number(table.rowCount) || 0, truncated: !!prev.truncated };
}

/**
 * ── 5. snapshot ── the ids the copy has, taken BEFORE fetching.
 * @param {Parameters<typeof ownerFilter>[0]} withAccess
 * @param {string} scopeKey
 * @param {string[]} warnings
 */
async function snapshotCopy(withAccess, scopeKey, warnings) {
    const snapQ = queryCompiler.compileIdList(withAccess, ownerFilter(withAccess, 'read'), C.PG);
    const snap = await datatableDbStore.query(scopeKey, scopeKey, snapQ.sql, snapQ.params);
    if (snap.truncated) {
        // Cannot happen under the cap, but if it did, deleting on a partial
        // snapshot would sweep live rows — so no deletions this pass.
        warnings.push('The copy holds more rows than one pass can read; nothing was deleted.');
    }
    return { snapshot: new Set((snap.rows || []).map((/** @type {Record<string, unknown>} */ r) => String(r.id))), snapTruncated: !!snap.truncated };
}

/**
 * ── 6. fetch ── page by page, capped; a row the adapter cannot identify is skipped and counted.
 * @param {PassAdapter} adapter
 * @param {OpenedSource} opened
 * @param {RowCtx} rowCtx
 * @param {{ rowCap: number, PAGE: number }} caps
 */
async function fetchRows(adapter, opened, rowCtx, { rowCap, PAGE }) {
    /** @type {Array<{ id: unknown, values: object }>} */
    const fetched = [];
    let offset = 0;
    let truncated = opened.truncated === true;
    let skippedRows = 0;
    for (;;) {
        const want = Math.min(PAGE, rowCap - fetched.length);
        if (want <= 0) { truncated = true; break; }
        const page = await opened.page(want, offset);
        for (const raw of page) {
            const row = adapter.rowFromSource(raw, rowCtx);
            if (row && row.id !== undefined && row.id !== null) fetched.push(row);
            else skippedRows += 1;
        }
        if (page.length < want) break;
        offset += page.length;
        if (fetched.length >= rowCap) {
            // One more probe tells "exactly at the cap" from "more behind it".
            const probe = await opened.page(1, offset);
            truncated = truncated || probe.length > 0;
            break;
        }
    }
    return { fetched, truncated, skippedRows };
}

/**
 * ── 8. upsert ── in batches; an unchanged row is a no-op. Returns the rows written.
 * @param {Parameters<typeof ownerFilter>[0]} withAccess
 * @param {string} scopeKey
 * @param {MirrorRow} table
 * @param {Array<{ id: unknown, values: object }>} fetched
 */
async function upsertRows(withAccess, scopeKey, table, fetched) {
    const updFilter = ownerFilter(withAccess, 'update');
    let written = 0;
    for (let i = 0; i < fetched.length; i += C.WRITE_CHUNK) {
        const stmts = fetched.slice(i, i + C.WRITE_CHUNK).map(({ id, values }) => (
            queryCompiler.compileUpsertById(withAccess, String(id), values, updFilter, {
                ...C.PG, createdBy: table.source.linkedByUserId || null, orgId: table.organizationId || null,
            })
        ));
        if (!stmts.length) continue;
        const results = await datatableDbStore.batch(scopeKey, scopeKey, stmts);
        for (const r of results) written += Number(r && r.changes) || 0;
    }
    return written;
}

/**
 * ── 9. delete ── snapshot − fetched. Returns the rows deleted.
 * @param {Parameters<typeof ownerFilter>[0]} withAccess
 * @param {string} scopeKey
 * @param {Set<string>} snapshot
 * @param {Set<string>} fetchedIds
 */
async function deleteGone(withAccess, scopeKey, snapshot, fetchedIds) {
    const gone = [...snapshot].filter(id => !fetchedIds.has(id));
    const delFilter = ownerFilter(withAccess, 'delete');
    let deleted = 0;
    for (let i = 0; i < gone.length; i += C.WRITE_CHUNK) {
        const stmts = gone.slice(i, i + C.WRITE_CHUNK).map(id => queryCompiler.compileDelete(withAccess, id, delFilter, C.PG));
        const results = await datatableDbStore.batch(scopeKey, scopeKey, stmts);
        for (const r of results) deleted += Number(r && r.changes) || 0;
    }
    return deleted;
}

/**
 * Steps 2 to 11 for a claimed mirror (see ./syncPipeline.js).
 * @param {PassAdapter} adapter
 * @param {MirrorRow} claimed
 * @param {{ reason: string, force?: boolean, PAGE: number, schedule: FinishCtx['schedule'], startedAt: number, warnings: string[] }} opts
 */
async function runPass(adapter, claimed, { reason, force, PAGE, schedule, startedAt, warnings }) {
    let table = claimed;
    const scope = claimed.scope;
    const prev = claimed.syncState || {};
    const { auth } = await adapter.resolveLinker(table.source, { orgId: table.organizationId || null });
    const api = adapter.apiFor(auth, table.source);
    const siblings = await adapter.siblingsOf(scope);
    const meta0 = await datatableStore.getTableMeta(scope, table.id);
    const rowCap = Math.min(C.ENGINE_READ_CAP, Number(table.source.rowCap) || C.DEFAULT_ROW_CAP);

    // ── 2b. open ── A source that can answer "nothing moved" cheaply may,
    // unless something says the copy is behind anyway: a forced pass, a
    // never-succeeded one, a stale mark, or a copy with no columns.
    const mustFetch = !!force || !prev.lastSuccessAt || !!prev.staleReason || !meta0;
    const opened = await adapter.open(api, table, { prev, mustFetch, rowCap });
    if (opened && opened.unchanged) return finishUnchanged(table, opened, { schedule, reason, startedAt, prev, warnings });
    warnings.push(...(opened.warnings || []));

    const cols = await reconcileColumns(adapter, table, opened.columns, siblings, meta0);
    table = cols.table;
    warnings.push(...cols.warnings);
    const meta = cols.meta;
    if (!meta) throw Object.assign(new Error('The mirror has no columns after reconciliation'), { code: 'mirror_no_columns' });
    const withAccess = { ...meta, access: synthesizeAccess(table) };
    const scopeKey = datatableDbStore.scopeKey(scope);

    // ── 4. indexes ── what the relation targets hold right now.
    const idx = await buildRelationIndexes(scope, table.source, { labelFieldFor: adapter.labelFieldFor || null });
    warnings.push(...idx.warnings);
    const rowCtx = {
        columnMap: table.source.columnMap, fieldsById: fieldsByIdOf(meta),
        relationIndexes: idx.relationIndexes, labelIndexes: idx.labelIndexes,
        source: table.source,
    };

    const { snapshot, snapTruncated } = await snapshotCopy(withAccess, scopeKey, warnings);
    const { fetched, truncated, skippedRows } = await fetchRows(adapter, opened, rowCtx, { rowCap, PAGE });
    const fetchedIds = new Set(fetched.map(r => String(r.id)));

    // ── 7. quota ── before anything is written.
    const newRows = [...fetchedIds].filter(id => !snapshot.has(id)).length;
    if (newRows > 0) await assertDatatableQuota(scope, { table, addRows: newRows });

    const written = await upsertRows(withAccess, scopeKey, table, fetched);
    // SKIPPED when the cap bit: a row beyond the cap is not a row the source lost.
    const deleted = (!truncated && !snapTruncated) ? await deleteGone(withAccess, scopeKey, snapshot, fetchedIds) : 0;

    // ── 10. bookkeeping ── the counters move only when rows did.
    const rowCount = truncated || snapTruncated
        ? new Set([...snapshot, ...fetchedIds]).size
        : fetchedIds.size;
    if (written > 0 || deleted > 0 || rowCount !== (Number(table.rowCount) || 0)) {
        await datatableStore.setRowCount(table.id, scope, rowCount);
    }

    // ── 11. finish ──
    const ok = okState(schedule, reason, startedAt);
    const state = await datatableStore.finishSourceSync(table.id, {
        status: ok.status, lastSyncAt: ok.lastSyncAt, lastSuccessAt: ok.lastSuccessAt, nextRunAt: ok.nextRunAt,
        lastError: null, lastErrorCode: null, consecutiveErrors: 0,
        rowCount, truncated, written, deleted,
        columnsChanged: cols.changes,
        staleReason: null,
        lastReason: reason,
        durationMs: ok.durationMs,
        warnings: warnings.slice(0, 10),
        // A full pass clears the 'unchanged' mark of the short-circuit
        // before it, or the state reads as both skipped and written.
        skipped: null,
        ...(skippedRows ? { skippedRows } : {}),
        ...(opened.statePatch || {}),
    });
    return { ok: true, syncState: state ? state.syncState : null, warnings, written, deleted, rowCount, truncated, skippedRows };
}

/**
 * A failed pass: recorded on `sync_state` with its backoff, and returned.
 * @param {PassAdapter} adapter
 * @param {MirrorRow} table
 * @param {Error & { code?: string, status?: number }} e   whatever the pass threw
 * @param {FinishCtx & { TAG: string }} ctx
 */
async function recordFailure(adapter, table, e, { prev, schedule, reason, startedAt, warnings, TAG }) {
    const consecutiveErrors = (Number(prev.consecutiveErrors) || 0) + 1;
    const now = new Date();
    const code = isSourceError(e) ? e.code : (e && typeof e.code === 'string' ? e.code : 'sync_failed');
    const state = await datatableStore.finishSourceSync(table.id, {
        status: 'error',
        lastSyncAt: now.toISOString(),
        nextRunAt: staleness.nextRunAtFor(schedule, now.getTime(), consecutiveErrors),
        lastError: String((e && e.message) || e).slice(0, C.MAX_ERROR_LEN),
        lastErrorCode: code,
        consecutiveErrors,
        lastReason: reason,
        durationMs: Date.now() - startedAt,
    }).catch((e) => fallback('core/dataEngine/sources/mirror/syncPass:recordFailure', e, null));
    if (!isSourceError(e) && !(e && e.status)) {
        log.warn(`${TAG} refresh of ${table.id} failed (${reason}): ${e && e.message}`);
    }
    return { ok: false, error: e, syncState: state ? state.syncState : null, warnings };
}

module.exports = { declaredOf, runPass, recordFailure };
