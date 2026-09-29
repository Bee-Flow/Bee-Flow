/**
 * App Studio connector sync — the scheduled half of "keep this table filled".
 *
 * Walks studio_app_connector_sync for rows whose next_run_at has passed and runs
 * each through appStudio/connectorSync.syncConnector. The other two triggers
 * (someone opening the app; the owner pressing "Refresh now") call the same
 * engine, so a scheduled refresh does exactly what the owner saw when they
 * tested it.
 *
 * Multi-replica safe via a Postgres advisory lock (the opsMetricsPush pattern
 * every job here follows), plus an in-process `_inFlight` guard so a slow
 * upstream can't stack ticks. syncConnector ALSO claims each row individually,
 * which is what actually prevents double-running — the advisory lock just keeps
 * the replicas from doing redundant scanning work.
 *
 * The per-tick LIMIT matters: a backlog (say an org enabling twenty connectors
 * at once) drains over several minutes instead of holding the tick — and every
 * other job behind it — for as long as twenty upstream APIs take to answer.
 */

const { pool } = require('../db');
const studioAppDataStore = require('../stores/studioAppDataStore');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF10C;
const INTERVAL_MS = 60 * 1000;          // the finest schedule granularity is a minute
const BOOT_DELAY_MS = 45 * 1000;
const MAX_PER_TICK = parseInt(process.env.STUDIO_APP_SYNC_PER_TICK, 10) || 20;
/**
 * How many due syncs run at once.
 *
 * This loop used to be strictly serial, so one slow upstream (a Graph call that
 * takes ten seconds) delayed every other connector behind it in the same tick.
 * With mailbox connectors polling every two minutes that head-of-line blocking
 * becomes the difference between "live" and "stuck". Each row is still claimed
 * individually by syncConnector, so running several at once is safe.
 */
const SYNC_CONCURRENCY = parseInt(process.env.STUDIO_APP_SYNC_CONCURRENCY, 10) || 3;

let _inFlight = false;
let _timer = null;

/**
 * Run one due sync. Resolves the app + model fresh, because the owner may have
 * edited (or deleted) the connector since the row was scheduled.
 *
 * Exported so the manual "Refresh now" path and the tests can reuse the same
 * resolution logic.
 */
async function syncOne(state) {
    const studioAppStore = require('../stores/studioAppStore');
    const connectors = require('../appStudio/connectors');
    const connectorSync = require('../appStudio/connectorSync');

    const app = await studioAppStore.getStudioApp(state.appId);
    if (!app) {
        // The app is gone; the FK cascade will take the row with it.
        return { ok: true, skipped: 'app_gone' };
    }
    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = meta?.model || null;
    const connector = connectors.findConnector(model, state.connectorId);

    // The owner removed the connector (or its sync block) — stop scheduling it
    // rather than failing forever against a model that no longer asks for it.
    if (!connector || !connector.sync) {
        await studioAppDataStore.deleteSyncState(state.appId, state.connectorId);
        return { ok: true, skipped: 'no_longer_synced' };
    }

    try {
        const result = await connectorSync.syncConnector(
            { id: app.id, userId: app.userId, organizationId: app.organizationId || null },
            model, connector, { reason: 'schedule' },
        );
        return { ok: true, result };
    } catch (e) {
        // syncConnector already recorded the error and scheduled the retry; the
        // job only needs to report health.
        return { ok: false, error: e.message };
    }
}

async function processDueSyncs() {
    if (_inFlight) return;
    _inFlight = true;
    let client = null;
    let acquired = false;
    const t0 = Date.now();
    let ok = true;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another replica owns this tick

        const due = await studioAppDataStore.listDueSyncs(MAX_PER_TICK);
        // A pool of workers pulling from one shared cursor: bounded parallelism
        // without letting a fast connector wait on a slow one.
        let cursor = 0;
        const workers = Array.from({ length: Math.min(SYNC_CONCURRENCY, due.length) }, async () => {
            for (;;) {
                const i = cursor++;
                if (i >= due.length) return;
                const r = await syncOne(due[i]);
                if (!r.ok) ok = false;
            }
        });
        await Promise.all(workers);
    } catch (e) {
        ok = false;
        log.warn('[StudioAppConnectorSync] tick error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'studio_app_connector_sync', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

/**
 * Mount the interval and the boot tick, both behind the runtime module gate,
 * so removing App Studio in the admin Modules panel stops connector syncs on a
 * running pod (BFSF-438). `gate` is a test seam; processDueSyncs stays ungated.
 */
function start({ gate } = {}) {
    if (_timer) return;
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('apps', processDueSyncs, 'studioAppConnectorSync');
    log.info(`[StudioAppConnectorSync] started: every ${INTERVAL_MS / 1000}s, up to ${MAX_PER_TICK} per tick, ${SYNC_CONCURRENCY} at a time`);
    _timer = setInterval(() => {
        gatedTick().catch((e) => log.warn('[StudioAppConnectorSync] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        gatedTick().catch((e) => log.warn('[StudioAppConnectorSync] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

module.exports = { start, processDueSyncs, syncOne, LOCK_KEY, MAX_PER_TICK };
