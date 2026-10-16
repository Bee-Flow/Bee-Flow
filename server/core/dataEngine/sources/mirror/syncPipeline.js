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
 * The steps themselves are ./syncPass.js, one function per number.
 *
 * `./schema` and `./relations` are required by those names on purpose: the
 * engine unit tests stub them by request string, and a stub keyed on the
 * string matches whichever file asks.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
// The pass itself, one function per numbered step.
const { declaredOf, runPass, recordFailure } = require('./syncPass');
const staleness = require('./staleness');
const C = require('./constants');

const DEFAULT_PAGE = 500;

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
        // ── 1. claim ── one pass per mirror at a time.
        const claimed = await datatableStore.claimSourceSync(datatable.id, { staleMs: C.CLAIM_STALE_MS });
        if (!claimed) return { ok: false, alreadyRunning: true, syncState: datatable.syncState || null };

        const startedAt = Date.now();
        const prev = claimed.syncState || {};
        const schedule = staleness.scheduleOf(claimed.source);
        const warnings = [];
        try {
            return await runPass(adapter, claimed, { reason, force, PAGE, schedule, startedAt, warnings });
        } catch (e) {
            return recordFailure(adapter, claimed, e, { prev, schedule, reason, startedAt, warnings, TAG });
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
