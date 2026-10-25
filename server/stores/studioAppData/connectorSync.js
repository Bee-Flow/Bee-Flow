// @typecheck
/**
 * Connector → table sync state (claim, finish, due list, reconcile against the
 * saved model) and the outbound e-mail ledger.
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { toIso } = require('./rowMappers');

// ── Connector sync state ────────────────────────────────────────────
//
// One row per (app, connector) that materialises into a table. Holds the things
// a refresh needs to be INCREMENTAL and IDEMPOTENT across replicas: when it last
// ran, when it is next due, and the high-watermark reached so far.
//
// The claim is a conditional UPDATE rather than a read-then-write, so two
// replicas ticking at the same second cannot both start the same sync. A crashed
// run would otherwise hold `running` forever, so a claim older than
// SYNC_STALE_MS is reclaimable.

const SYNC_STALE_MS = 15 * 60 * 1000;

function mapSyncRow(r) {
    if (!r) return null;
    return {
        appId: r.app_id,
        connectorId: r.connector_id,
        ownerUserId: r.owner_user_id,
        tableKey: r.table_key || null,
        status: r.status || 'idle',
        lastRunAt: toIso(r.last_run_at),
        nextRunAt: toIso(r.next_run_at),
        startedAt: toIso(r.started_at),
        watermark: r.watermark || null,
        rowsWritten: parseInt(r.rows_written) || 0,
        lastError: r.last_error || null,
        consecutiveErrors: parseInt(r.consecutive_errors) || 0,
    };
}

async function getSyncState(appId, connectorId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_connector_sync WHERE app_id = $1 AND connector_id = $2`,
        [appId, connectorId],
    );
    return mapSyncRow(r);
}

async function listSyncStates(appId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_connector_sync WHERE app_id = $1 ORDER BY connector_id`, [appId],
    );
    return (rows || []).map(mapSyncRow);
}

/**
 * Claim a sync for this process. Returns the claimed state, or null when another
 * replica (or an earlier tick in this one) already owns it. Creates the row on
 * first use, so a connector never needs an explicit "register" step.
 */
async function claimSync(appId, connectorId, ownerUserId, { tableKey = null } = {}) {
    await initDB();
    const staleBefore = new Date(Date.now() - SYNC_STALE_MS).toISOString();
    const r = await getOne(
        `INSERT INTO studio_app_connector_sync (app_id, connector_id, owner_user_id, table_key, status, started_at)
         VALUES ($1, $2, $3, $4, 'running', NOW())
         ON CONFLICT (app_id, connector_id) DO UPDATE
            SET status = 'running', started_at = NOW(), table_key = $4, updated_at = NOW()
          WHERE studio_app_connector_sync.status <> 'running'
             OR studio_app_connector_sync.started_at IS NULL
             OR studio_app_connector_sync.started_at < $5
         RETURNING *`,
        [appId, connectorId, ownerUserId, tableKey, staleBefore],
    );
    return mapSyncRow(r);
}

/**
 * Release a claim, recording the outcome and when the next run is due.
 * @param appId
 * @param connectorId
 * @param {{ status?: string, watermark?: any, rowsWritten?: number, nextRunAt?: string|Date, error?: string, consecutiveErrors?: number }} [opts]
 */
async function finishSync(appId, connectorId, { status, watermark, rowsWritten, nextRunAt, error, consecutiveErrors } = {}) {
    await initDB();
    // The streak counter is what lets the caller widen the retry gap. Passing
    // null keeps whatever is stored, so an older caller that doesn't know about
    // it can't accidentally reset a back-off.
    const streak = Number.isInteger(consecutiveErrors) ? consecutiveErrors : null;
    const r = await getOne(
        `UPDATE studio_app_connector_sync
            SET status = $3,
                last_run_at = NOW(),
                started_at = NULL,
                next_run_at = $4,
                watermark = COALESCE($5, watermark),
                rows_written = $6,
                last_error = $7,
                consecutive_errors = COALESCE($8, consecutive_errors),
                updated_at = NOW()
          WHERE app_id = $1 AND connector_id = $2
          RETURNING *`,
        [appId, connectorId, status === 'error' ? 'error' : 'ok',
         nextRunAt || null, watermark ?? null, parseInt(rowsWritten) || 0,
         error ? String(error).slice(0, 500) : null, streak],
    );
    return mapSyncRow(r);
}

/**
 * Syncs whose next_run_at has passed. The background job walks this; the LIMIT
 * bounds one tick so a backlog drains over several minutes instead of stalling
 * the tick (and every other job behind it).
 * @param {number} [limit]
 */
async function listDueSyncs(limit = 25) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_connector_sync
          WHERE next_run_at IS NOT NULL AND next_run_at <= NOW()
            AND (status <> 'running' OR started_at IS NULL OR started_at < $2)
          ORDER BY next_run_at ASC
          LIMIT $1`,
        [Math.max(1, Math.min(200, parseInt(limit) || 25)), new Date(Date.now() - SYNC_STALE_MS).toISOString()],
    );
    return (rows || []).map(mapSyncRow);
}

/**
 * Append one outbound message to the ledger.
 * @param {{ appId?: string, connectorId?: string, viewerUserId?: string, effectiveUserId?: string, toMasked?: string, subject?: string, providerMessageId?: string, threadKey?: string, dlpOutcome?: string }} [opts]
 */
async function logEmailSend({
    appId, connectorId, viewerUserId, effectiveUserId,
    toMasked, subject, providerMessageId, threadKey, dlpOutcome,
} = {}) {
    await initDB();
    await run(
        `INSERT INTO studio_app_email_log
            (app_id, connector_id, viewer_user_id, effective_user_id, to_masked, subject, provider_message_id, thread_key, dlp_outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [appId, connectorId, viewerUserId || null, effectiveUserId || null,
         toMasked || null, subject || null, providerMessageId || null, threadKey || null, dlpOutcome || null],
    );
}

/** The app's outbound history, newest first. */
async function listEmailSends(appId, { limit = 100 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_email_log WHERE app_id = $1 ORDER BY sent_at DESC LIMIT $2`,
        [appId, Math.max(1, Math.min(500, parseInt(limit) || 100))],
    );
    return (rows || []).map((r) => ({
        id: String(r.id),
        connectorId: r.connector_id,
        viewerUserId: r.viewer_user_id || null,
        effectiveUserId: r.effective_user_id || null,
        toMasked: r.to_masked || null,
        subject: r.subject || null,
        providerMessageId: r.provider_message_id || null,
        threadKey: r.thread_key || null,
        dlpOutcome: r.dlp_outcome || null,
        sentAt: toIso(r.sent_at),
    }));
}

/** Forget a connector's sync state (the connector or its table was removed). */
async function deleteSyncState(appId, connectorId) {
    await initDB();
    await run(`DELETE FROM studio_app_connector_sync WHERE app_id = $1 AND connector_id = $2`, [appId, connectorId]);
}

/**
 * Bring the sync rows in line with the model that was just saved.
 *
 * A connector that fills a table needs a row here before the background job can
 * ever see it — `listDueSyncs` selects on `next_run_at`, and until this ran the
 * ONLY thing that created a row was a sync actually starting. That is a deadlock:
 * a freshly configured schedule would never fire on its own, so the table stayed
 * empty until someone happened to open the app or press "Refresh now" — and
 * silently forever if they turned on-view refresh off.
 *
 * Seeding `next_run_at = NOW()` means saving the model IS the trigger for the
 * first fill; the job picks it up on its next tick (≤60s). Existing rows are left
 * alone so an in-flight run and its watermark survive a model edit.
 *
 * @param {string[]} syncedConnectorIds  ids of connectors that carry a sync block
 * @returns {Promise<{ seeded: string[], removed: number }>}
 */
async function reconcileSyncStates(appId, ownerId, syncedConnectorIds = []) {
    await initDB();
    const wanted = [...new Set((syncedConnectorIds || []).filter((id) => typeof id === 'string' && id))];

    // Drop rows for connectors that no longer fill a table.
    let removed = 0;
    if (wanted.length) {
        const res = await run(
            `DELETE FROM studio_app_connector_sync WHERE app_id = $1 AND NOT (connector_id = ANY($2::text[]))`,
            [appId, wanted],
        );
        removed = res?.rowCount || 0;
    } else {
        const res = await run(`DELETE FROM studio_app_connector_sync WHERE app_id = $1`, [appId]);
        removed = res?.rowCount || 0;
    }

    // Seed the ones we've never seen, due immediately.
    const seeded = [];
    for (const connectorId of wanted) {
        const row = await getOne(
            `INSERT INTO studio_app_connector_sync (app_id, connector_id, owner_user_id, status, next_run_at)
             VALUES ($1, $2, $3, 'idle', NOW())
             ON CONFLICT (app_id, connector_id) DO NOTHING
             RETURNING connector_id`,
            [appId, connectorId, ownerId],
        );
        if (row) seeded.push(row.connector_id);
    }
    return { seeded, removed };
}

module.exports = {
    getSyncState,
    listSyncStates,
    claimSync,
    finishSync,
    listDueSyncs,
    deleteSyncState,
    reconcileSyncStates,
    SYNC_STALE_MS,
    logEmailSend,
    listEmailSends,
};
