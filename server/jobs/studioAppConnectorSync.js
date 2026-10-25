// @typecheck
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
 * every job here follows), plus an in-process in-flight guard (jobs/lib/workerPool.js) so a slow
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
const log = require('../telemetry/log');
const { createLockedTick, runWorkerPool } = require('./lib/workerPool');

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

/** @type {NodeJS.Timeout | null} */
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
        return { ok: false, error: /** @type {Error} */ (e).message };
    }
}

// One tick: the advisory lock, the in-flight guard and the job-run metric
// live in jobs/lib/workerPool.js; a pool of workers pulls from one shared
// cursor so a fast item never waits on a slow one.
const processDueSyncs = createLockedTick({
    pool,
    lockKey: LOCK_KEY,
    job: 'studio_app_connector_sync',
    label: 'StudioAppConnectorSync',
    run: async () => {
        let ok = true;
        const due = await studioAppDataStore.listDueSyncs(MAX_PER_TICK);
        await runWorkerPool(due, SYNC_CONCURRENCY, async (item) => {
            const r = await syncOne(item);
            if (!r.ok) ok = false;
        });
        return ok;
    },
});

/**
 * Mount the interval and the boot tick, both behind the runtime module gate,
 * so removing App Studio in the admin Modules panel stops connector syncs on a
 * running pod (BFSF-438). `gate` is a test seam; processDueSyncs stays ungated.
 * @param {{ gate?: Function }} [opts]
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
