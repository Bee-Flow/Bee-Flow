// @typecheck
'use strict';

/**
 * A table whose ROWS come from somewhere else.
 *
 * Only the two blobs move here — `source` (where the rows come from and how the
 * columns map) and `sync_state` (how the last fetch went). The claim/finish
 * cycle, the staleness marks, the due list the ticker reads and the four
 * fan-out lookups are all this module owns; what any of it MEANS is
 * core/dataEngine/sources' business, one adapter per kind on one engine.
 */

const { run, getOne, getAll } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');
const { getDatatable } = require('./datatables');

// Everything about WHERE a mirror's rows come from lives in `source`, and how
// the last fetch went in `sync_state`. The functions here only move those two
// blobs; what they mean is core/dataEngine/sources' business (one adapter per
// kind, one engine).
//
// The kinds are a LITERAL list here, not an import: stores/ is platform and
// may not require core/ (layering.test.js), and core/dataEngine/sources/
// index.test.js pins the two lists against each other. The list is inlined
// into every WHERE as constants, never bound as a parameter: the partial
// indexes are declared on `managed_kind IN ('…', '…')`, and a bind parameter
// (`= ANY($1)`) cannot prove a partial-index predicate to the planner.

const SOURCE_KINDS = Object.freeze(['nextcloud_table', 'spreadsheet_file']);
const KIND_LIST = SOURCE_KINDS.map(k => `'${k}'`).join(', ');
// One-release alias: the first kind, for callers that still name it.
const MIRROR_KIND = SOURCE_KINDS[0];

function assertSourceKind(kind, who) {
    if (kind !== null && kind !== undefined && !SOURCE_KINDS.includes(kind)) {
        throw new Error(`${who}: unknown source kind ${String(kind)}`);
    }
}

/** Replace a mirror's `source` block whole. Scoped, like every other write. */
async function setSource(id, scope, source) {
    await initDB();
    assertScope(scope, 'setSource');
    await run(
        `UPDATE datatables SET source = $4::jsonb, updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3 AND managed_kind IN (${KIND_LIST})`,
        [id, scope.kind, scope.id, source ? JSON.stringify(source) : null],
    );
    return getDatatable(id, scope);
}

/**
 * Claim a full refresh of one mirror for this process.
 *
 * The studioAppDataStore.claimSync idiom on the `datatables` row itself: the
 * UPDATE only lands when no pass is running, or when the running one is older
 * than `staleMs` (a replica that died mid-pass must not park the mirror for
 * ever). Returns the claimed table, or null when another replica — or an
 * earlier tick in this one — already owns it.
 *
 * UNSCOPED on purpose, and safe for the same reason getDataVersion is: the
 * ticker holds only ids, and the row is the authority on which tenant it
 * belongs to — the caller gets the whole row back and reads the scope off it.
 * The `managed_kind` guard means an ordinary table can never be "claimed".
 */
async function claimSourceSync(id, { staleMs = 10 * 60 * 1000 } = {}) {
    await initDB();
    if (!id) return null;
    const staleBefore = new Date(Date.now() - staleMs).toISOString();
    const r = await getOne(
        `UPDATE datatables
            SET sync_state = COALESCE(sync_state, '{}'::jsonb)
                          || jsonb_build_object('status', 'running', 'startedAt', NOW()),
                updated_at = NOW()
          WHERE id = $1 AND managed_kind IN (${KIND_LIST})
            AND (sync_state IS NULL
                 OR sync_state->>'status' IS DISTINCT FROM 'running'
                 OR sync_state->>'startedAt' IS NULL
                 OR (sync_state->>'startedAt')::timestamptz < $2::timestamptz)
          RETURNING *`,
        [id, staleBefore],
    );
    return rowToDatatable(r);
}

/**
 * Release a claim, recording how the pass went. `patch` is merged INTO the
 * stored state (jsonb ||), so a caller records only what it knows; `startedAt`
 * is always cleared because the pass is over, whatever its outcome.
 *
 * ONE thing survives the patch: a `staleReason` that was set AFTER the claim
 * (markSourceStale stamps `lastEventAt`). A write-through that landed while
 * the pass was fetching, or a push event that arrived mid-pass, marked the
 * copy behind — and the finishing pass, which read the source BEFORE that,
 * must not clear the mark or the next tick would believe the copy current.
 * The cast is fine here: an UPDATE may use `::timestamptz`; only an INDEX
 * expression must stay IMMUTABLE.
 */
async function finishSourceSync(id, patch) {
    await initDB();
    if (!id) return null;
    const r = await getOne(
        `UPDATE datatables
            SET sync_state = ((COALESCE(sync_state, '{}'::jsonb) || $2::jsonb) - 'startedAt')
                          || CASE WHEN sync_state->>'lastEventAt' IS NOT NULL
                                   AND sync_state->>'startedAt' IS NOT NULL
                                   AND (sync_state->>'lastEventAt')::timestamptz > (sync_state->>'startedAt')::timestamptz
                                  THEN jsonb_build_object('staleReason', sync_state->>'staleReason')
                                  ELSE '{}'::jsonb END,
                updated_at = NOW()
          WHERE id = $1 AND managed_kind IN (${KIND_LIST})
          RETURNING *`,
        [id, JSON.stringify(patch || {})],
    );
    return rowToDatatable(r);
}

/**
 * Merge a few keys INTO the sync state without touching a pass that may be
 * running (`status`, `startedAt` stay as they are): a write-through records
 * the file's new marker and content hash so the next probe reads
 * "unchanged" instead of re-downloading what it just wrote.
 */
async function patchSyncState(id, patch) {
    await initDB();
    if (!id) return null;
    const r = await getOne(
        `UPDATE datatables
            SET sync_state = COALESCE(sync_state, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
          WHERE id = $1 AND managed_kind IN (${KIND_LIST})
          RETURNING *`,
        [id, JSON.stringify(patch || {})],
    );
    return rowToDatatable(r);
}

/**
 * Move the ticker's next look at a mirror — after a schedule change — without
 * touching anything else about a pass that may be running right now
 * (finishSourceSync would clear its claim).
 */
async function setSourceNextRun(id, nextRunAt) {
    await initDB();
    if (!id) return;
    await run(
        `UPDATE datatables
            SET sync_state = COALESCE(sync_state, '{}'::jsonb) || jsonb_build_object('nextRunAt', $2::text),
                updated_at = NOW()
          WHERE id = $1 AND managed_kind IN (${KIND_LIST})`,
        [id, nextRunAt === null ? null : String(nextRunAt)],
    );
}

/**
 * Say that a mirror's copy is known to be behind — a push event for a VIEW
 * mirror (its filter cannot be evaluated locally), a file event, a relation
 * edit, a write-through that landed mid-pass — so the next refresh-on-open or
 * tick runs a full pass regardless of the schedule. Never touches `status`:
 * a pass that is running keeps running (and finishSourceSync keeps this mark
 * when it was set after the claim).
 */
async function markSourceStale(id, reason) {
    await initDB();
    if (!id) return;
    await run(
        `UPDATE datatables
            SET sync_state = COALESCE(sync_state, '{}'::jsonb)
                          || jsonb_build_object('staleReason', $2::text, 'lastEventAt', NOW()),
                updated_at = NOW()
          WHERE id = $1 AND managed_kind IN (${KIND_LIST})`,
        [id, String(reason || 'event')],
    );
}

/**
 * Mirrors whose scheduled refresh is due, oldest first, of EVERY kind: the
 * ticker is one job and dispatches by kind. Unscoped: this is the ticker's
 * question, a platform job with no viewer (same reasoning as
 * listDatatablesWithRetention). A running pass is skipped — the claim is
 * what decides, this only narrows the candidates. A NULL `sync_state` is a
 * mirror that has never been refreshed (its first pass died with the
 * process) and is due; a NULL `nextRunAt` INSIDE a state is a schedule of
 * "never" and is not.
 */
async function listDueSourceSyncs(limit = 20) {
    await initDB();
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind IN (${KIND_LIST})
            AND (sync_state IS NULL
                 OR sync_state->>'nextRunAt' <= $2)
            AND sync_state->>'status' IS DISTINCT FROM 'running'
          ORDER BY sync_state->>'nextRunAt' ASC NULLS FIRST, id ASC
          LIMIT $1`,
        [Math.max(1, Math.min(200, Number(limit) || 20)), new Date().toISOString()],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Every mirror in ONE organisation that copies Nextcloud table `ncTableId` —
 * the webhook fan-out (idx_datatables_nc_table). Narrowed to the organisation
 * the signed event came from, never wider: a personal mirror linked by a member
 * of that org carries `organization_id` NULL and is deliberately NOT reached
 * here — it refreshes on open and on schedule like any other.
 */
async function listNcMirrorsForTable(organizationId, ncTableId) {
    await initDB();
    if (!organizationId || !Number.isInteger(ncTableId)) return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind = $1 AND organization_id = $2
            AND (source->>'ncTableId')::int = $3`,
        [MIRROR_KIND, organizationId, ncTableId],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Every mirror of `kind` in ONE organisation whose source is file `fileId`
 * at `provider` — the file-event fan-out (idx_datatables_source_file). The
 * same organisation narrowing as listNcMirrorsForTable, for the same reason.
 */
async function listSourceMirrorsByRef(organizationId, { kind, provider, fileId }) {
    await initDB();
    assertSourceKind(kind, 'listSourceMirrorsByRef');
    if (!organizationId || !kind || !provider || fileId === null || fileId === undefined || fileId === '') return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind = $1 AND organization_id = $2
            AND source->>'provider' = $3 AND source->'file'->>'id' = $4`,
        [kind, organizationId, String(provider), String(fileId)],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * The same fan-out by the file's PATH — for a delete event, which carries no
 * id. Unindexed on purpose: deletes and renames are rare, and an index on a
 * path nobody else asks by would cost every write.
 */
async function listSourceMirrorsByPath(organizationId, { kind, provider, path }) {
    await initDB();
    assertSourceKind(kind, 'listSourceMirrorsByPath');
    if (!organizationId || !kind || !provider || typeof path !== 'string' || !path) return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind = $1 AND organization_id = $2
            AND source->>'provider' = $3 AND source->'file'->>'path' = $4`,
        [kind, organizationId, String(provider), path],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Every mirror one account linked at one provider, whatever its scope — the
 * "something changed in this person's drive" hint, which names no file.
 * Unscoped like the ticker's question: the hint is a platform event about
 * the linker, and each mirror row says which tenant it belongs to.
 */
async function listSourceMirrorsByLinker(userId, provider) {
    await initDB();
    if (!userId || !provider) return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind IN (${KIND_LIST})
            AND source->>'linkedByUserId' = $1 AND source->>'provider' = $2`,
        [String(userId), String(provider)],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Every mirror in one scope — "already linked" checks and relation targets.
 * All kinds unless `kind` narrows it: a relation may point at a mirror of
 * another kind, but "is this Nextcloud table already linked" is asked of one.
 */
async function listSourceMirrorsInScope(scope, { kind = null } = {}) {
    await initDB();
    assertScope(scope, 'listSourceMirrorsInScope');
    assertSourceKind(kind, 'listSourceMirrorsInScope');
    const res = kind
        ? await getAll(
            `SELECT * FROM datatables
              WHERE managed_kind = $3 AND scope_kind = $1 AND scope_id = $2
              ORDER BY name ASC`,
            [scope.kind, scope.id, kind],
        )
        : await getAll(
            `SELECT * FROM datatables
              WHERE managed_kind IN (${KIND_LIST}) AND scope_kind = $1 AND scope_id = $2
              ORDER BY name ASC`,
            [scope.kind, scope.id],
        );
    return (res || []).map(rowToDatatable);
}

// One-release aliases under the Nextcloud-era names. `listNcMirrorsInScope`
// keeps its old meaning (this kind only), the others are the same function.
const claimNcSync = claimSourceSync;
const finishNcSync = finishSourceSync;
const setNcNextRun = setSourceNextRun;
const markNcStale = markSourceStale;
const listDueNcSyncs = listDueSourceSyncs;
const listNcMirrorsInScope = (scope) => listSourceMirrorsInScope(scope, { kind: MIRROR_KIND });

module.exports = {
    SOURCE_KINDS,
    setSource,
    claimSourceSync,
    finishSourceSync,
    patchSyncState,
    setSourceNextRun,
    markSourceStale,
    listDueSourceSyncs,
    listNcMirrorsForTable,
    listSourceMirrorsByRef,
    listSourceMirrorsByPath,
    listSourceMirrorsByLinker,
    listSourceMirrorsInScope,
    // one-release aliases
    MIRROR_KIND,
    claimNcSync,
    finishNcSync,
    setNcNextRun,
    markNcStale,
    listDueNcSyncs,
    listNcMirrorsInScope,
};
