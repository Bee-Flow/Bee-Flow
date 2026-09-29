/**
 * ONE FULL PASS over a mirror: the source's columns and rows → the copy —
 * the same pass for every kind, with the adapter answering the three
 * questions only it can: how to reach the source, what its columns are,
 * and what one of its rows means.
 *
 * ── THE ORDER IS THE CORRECTNESS ────────────────────────────────────
 *   1. claim         one pass per mirror at a time (datatableStore.claimSourceSync)
 *   2. linker        who the source sees, and the adapter's gates (resolveLinker)
 *   2b. open         the adapter looks at the source: a cheap probe may answer
 *                    "unchanged" (a file whose version marker did not move) and
 *                    the pass ends here — no snapshot, no batch, no counter, so
 *                    data_version never moves for a look that found nothing
 *   3. columns       derive fields; reconcile the schema only when they moved
 *   4. indexes       what the relation targets hold right now (relations.js)
 *   5. SNAPSHOT      the ids the copy has — taken BEFORE fetching, so a row a
 *                    push event or a write-through inserts while this pass runs
 *                    is never mistaken for "gone from the source"
 *   6. fetch         page by page, capped (the engine reads at most 10k ids
 *                    back, so the cap can never exceed what step 5 can see);
 *                    a row the adapter cannot identify is SKIPPED and counted
 *   7. quota         before anything is written
 *   8. upsert        in batches; an unchanged row is a no-op (compileUpsertById)
 *   9. delete        snapshot − fetched — SKIPPED when the cap bit, because a
 *                    row beyond the cap is not a row the source lost
 *  10. bookkeeping   the counters move only when rows did: an idle pass must
 *                    not bump data_version, or every scheduled refresh would
 *                    re-embed a knowledge base that did not change
 *  11. finish        the state, and when to come back (backoff on failure);
 *                    the adapter's `statePatch` (a marker, a content hash,
 *                    identity counters) rides along
 *
 * Never throws for a reason the OWNER should read: a failure is recorded on
 * `sync_state` (status, lastError, lastErrorCode) and returned. Only a
 * programming error escapes.
 *
 * ── THE ADAPTER ─────────────────────────────────────────────────────
 *   { KIND, TAG, PAGE?, isMirror(table),
 *     resolveLinker(source, { orgId }) → { auth, … },
 *     apiFor(auth, source) → api,
 *     siblingsOf(scope) → { byId: Map<id, table>, …kind maps },
 *     open(api, table, { prev, mustFetch, rowCap })
 *         → { unchanged: true, statePatch }
 *         | { columns, page(limit, offset) → Promise<raw[]>, statePatch?, warnings?, truncated? }
 *           (truncated: an adapter that read the whole source at open time —
 *            a file — already knows the cap bit; the probe below cannot see
 *            past what the reader kept),
 *     deriveFields(columns, { existingFields, siblings, declaredRelations, source })
 *         → { fields, columnMap, relations, warnings, changes, retyped, sourcePatch? }
 *           (sourcePatch: extra keys of the source block that must follow the
 *            columns — a spreadsheet's identity block names the key column's
 *            field id, which a retype changes),
 *     rowFromSource(raw, { columnMap, fieldsById, relationIndexes, labelIndexes, source })
 *         → { id, values } | null,
 *     labelFieldFor?(rel, targetTable) → fieldId | null }
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

const DEFAULT_PAGE = 500;

/** The declared (match) relations, with what the adapter needs to name their column. */
function declaredOf(source, siblings) {
    return ((source && source.relations) || [])
        .filter(r => r && r.kind === 'match')
        .map((r) => {
            const target = siblings.byId.get(r.targetDatatableId);
            return { ...r, targetKey: target ? target.key : null, targetName: target ? target.name : null };
        });
}

/**
 * @param {object} adapter   see the header
 * @returns {object} the kind's `sync` module: syncRows, isStale, kickStale, …
 */
function makeSync(adapter) {
    if (!adapter || typeof adapter.open !== 'function' || typeof adapter.isMirror !== 'function') {
        throw new Error('makeSync: an adapter with open() and isMirror() is required');
    }
    const TAG = adapter.TAG || `[${adapter.KIND}]`;
    const PAGE = Number(adapter.PAGE) || DEFAULT_PAGE;

    /**
     * Bring the mirror's field list in step with the source's columns.
     * Returns the (possibly new) table and meta, and what changed.
     */
    async function reconcileColumns(table, columns, siblings, meta) {
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
     * @param {object} datatable   a datatables row of this adapter's kind
     * @param {object} [opts]
     * @param {string} [opts.reason]   'link'|'view'|'live'|'schedule'|'manual'|'event'|'relations'|'write'
     * @param {boolean} [opts.force]   re-read the source even if its marker did not move. It never
     *                                 takes over a running claim: two passes writing one copy at
     *                                 once could leave the older bytes in it under the newer
     *                                 marker. A caller that must run after the pass in flight
     *                                 marks the copy stale and kicks (the mark survives the
     *                                 finish); only a claim older than CLAIM_STALE_MS — a replica
     *                                 that died mid-pass — is ever taken over
     * @returns {Promise<{ ok:boolean, alreadyRunning?:boolean, syncState:object|null, warnings?:string[] }>}
     */
    async function syncRows(datatable, { reason = 'manual', force = false } = {}) {
        if (!datatable || !adapter.isMirror(datatable) || !datatable.source) {
            throw new Error(`syncRows: not a ${adapter.KIND} mirror`);
        }
        const claimed = await datatableStore.claimSourceSync(datatable.id, { staleMs: C.CLAIM_STALE_MS });
        if (!claimed) return { ok: false, alreadyRunning: true, syncState: datatable.syncState || null };

        const startedAt = Date.now();
        const scope = claimed.scope;
        const prev = claimed.syncState || {};
        const schedule = staleness.scheduleOf(claimed.source);
        const warnings = [];
        let table = claimed;

        try {
            const { auth } = await adapter.resolveLinker(table.source, { orgId: table.organizationId || null });
            const api = adapter.apiFor(auth, table.source);
            const siblings = await adapter.siblingsOf(scope);
            const meta0 = await datatableStore.getTableMeta(scope, table.id);
            const rowCap = Math.min(C.ENGINE_READ_CAP, Number(table.source.rowCap) || C.DEFAULT_ROW_CAP);

            // ── 2b. open ───────────────────────────────────────────────
            // A source that can answer "nothing moved" cheaply may, unless
            // something says the copy is behind anyway: a forced pass, a
            // never-succeeded one, a stale mark, or a copy with no columns.
            const mustFetch = !!force || !prev.lastSuccessAt || !!prev.staleReason || !meta0;
            const opened = await adapter.open(api, table, { prev, mustFetch, rowCap });
            if (opened && opened.unchanged) {
                const now = new Date();
                const state = await datatableStore.finishSourceSync(table.id, {
                    status: 'ok',
                    lastSyncAt: now.toISOString(),
                    lastSuccessAt: now.toISOString(),
                    nextRunAt: staleness.nextRunAtFor(schedule, now.getTime(), 0),
                    lastError: null,
                    lastErrorCode: null,
                    consecutiveErrors: 0,
                    written: 0,
                    deleted: 0,
                    staleReason: null,
                    lastReason: reason,
                    durationMs: Date.now() - startedAt,
                    skipped: 'unchanged',
                    ...(opened.statePatch || {}),
                });
                return { ok: true, unchanged: true, syncState: state ? state.syncState : null, warnings, written: 0, deleted: 0, rowCount: Number(table.rowCount) || 0, truncated: !!prev.truncated };
            }
            warnings.push(...(opened.warnings || []));

            // ── 3. columns ─────────────────────────────────────────────
            const cols = await reconcileColumns(table, opened.columns, siblings, meta0);
            table = cols.table;
            warnings.push(...cols.warnings);
            const meta = cols.meta;
            if (!meta) throw Object.assign(new Error('The mirror has no columns after reconciliation'), { code: 'mirror_no_columns' });
            const withAccess = { ...meta, access: synthesizeAccess(table) };
            const fieldsById = fieldsByIdOf(meta);
            const scopeKey = datatableDbStore.scopeKey(scope);

            // ── 4. indexes ─────────────────────────────────────────────
            const idx = await buildRelationIndexes(scope, table.source, { labelFieldFor: adapter.labelFieldFor || null });
            warnings.push(...idx.warnings);
            const rowCtx = {
                columnMap: table.source.columnMap, fieldsById,
                relationIndexes: idx.relationIndexes, labelIndexes: idx.labelIndexes,
                source: table.source,
            };

            // ── 5. snapshot ────────────────────────────────────────────
            const snapQ = queryCompiler.compileIdList(withAccess, ownerFilter(withAccess, 'read'), C.PG);
            const snap = await datatableDbStore.query(scopeKey, scopeKey, snapQ.sql, snapQ.params);
            const snapshot = new Set((snap.rows || []).map(r => String(r.id)));
            if (snap.truncated) {
                // Cannot happen under the cap, but if it did, deleting on a partial
                // snapshot would sweep live rows — so no deletions this pass.
                warnings.push('The copy holds more rows than one pass can read; nothing was deleted.');
            }

            // ── 6. fetch ───────────────────────────────────────────────
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
            const fetchedIds = new Set(fetched.map(r => String(r.id)));

            // ── 7. quota ───────────────────────────────────────────────
            const newRows = [...fetchedIds].filter(id => !snapshot.has(id)).length;
            if (newRows > 0) await assertDatatableQuota(scope, { table, addRows: newRows });

            // ── 8. upsert ──────────────────────────────────────────────
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

            // ── 9. delete ──────────────────────────────────────────────
            let deleted = 0;
            if (!truncated && !snap.truncated) {
                const gone = [...snapshot].filter(id => !fetchedIds.has(id));
                const delFilter = ownerFilter(withAccess, 'delete');
                for (let i = 0; i < gone.length; i += C.WRITE_CHUNK) {
                    const stmts = gone.slice(i, i + C.WRITE_CHUNK).map(id => queryCompiler.compileDelete(withAccess, id, delFilter, C.PG));
                    const results = await datatableDbStore.batch(scopeKey, scopeKey, stmts);
                    for (const r of results) deleted += Number(r && r.changes) || 0;
                }
            }

            // ── 10. bookkeeping ────────────────────────────────────────
            const rowCount = truncated || snap.truncated
                ? new Set([...snapshot, ...fetchedIds]).size
                : fetchedIds.size;
            if (written > 0 || deleted > 0 || rowCount !== (Number(table.rowCount) || 0)) {
                await datatableStore.setRowCount(table.id, scope, rowCount);
            }

            // ── 11. finish ─────────────────────────────────────────────
            const now = new Date();
            const state = await datatableStore.finishSourceSync(table.id, {
                status: 'ok',
                lastSyncAt: now.toISOString(),
                lastSuccessAt: now.toISOString(),
                nextRunAt: staleness.nextRunAtFor(schedule, now.getTime(), 0),
                lastError: null,
                lastErrorCode: null,
                consecutiveErrors: 0,
                rowCount,
                truncated,
                written,
                deleted,
                columnsChanged: cols.changes,
                staleReason: null,
                lastReason: reason,
                durationMs: Date.now() - startedAt,
                warnings: warnings.slice(0, 10),
                // A full pass clears the 'unchanged' mark of the short-circuit
                // before it, or the state reads as both skipped and written.
                skipped: null,
                ...(skippedRows ? { skippedRows } : {}),
                ...(opened.statePatch || {}),
            });
            return { ok: true, syncState: state ? state.syncState : null, warnings, written, deleted, rowCount, truncated, skippedRows };
        } catch (e) {
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
            }).catch(() => null);
            if (!isSourceError(e) && !(e && e.status)) {
                log.warn(`${TAG} refresh of ${table.id} failed (${reason}): ${e && e.message}`);
            }
            return { ok: false, error: e, syncState: state ? state.syncState : null, warnings };
        }
    }

    const kickStale = staleness.makeKickStale({ syncRows, isMirror: adapter.isMirror, TAG });

    return {
        syncRows,
        isStale: staleness.isStale,
        kickStale,
        nextRunAtFor: staleness.nextRunAtFor,
        scheduleOf: staleness.scheduleOf,
        siblingsOf: (scope) => adapter.siblingsOf(scope),
        DEFAULT_ROW_CAP: C.DEFAULT_ROW_CAP,
        ENGINE_READ_CAP: C.ENGINE_READ_CAP,
        DEFAULT_MINUTES: C.DEFAULT_MINUTES,
        MIN_MIRROR_MINUTES: C.MIN_MIRROR_MINUTES,
        MAX_MIRROR_MINUTES: C.MAX_MIRROR_MINUTES,
        LIVE_STALE_MS: C.LIVE_STALE_MS,
        CLAIM_STALE_MS: C.CLAIM_STALE_MS,
        _kicks: staleness._kicks,
    };
}

module.exports = { makeSync, declaredOf };
