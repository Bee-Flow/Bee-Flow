/**
 * Source mirror refresh — the SCHEDULED half of "keep this copy in step".
 *
 * Walks `datatables` for mirrors of EVERY kind whose `sync_state.nextRunAt`
 * has passed and runs each through core/dataEngine/sources.syncRows, which
 * dispatches to the kind's own engine (a Nextcloud table, a spreadsheet
 * file). The other three triggers (a push event, somebody opening the rows,
 * "Refresh now") call the same engine, so a scheduled refresh does exactly
 * what the owner saw when they pressed the button. One ticker for every
 * kind: the file keeps its Nextcloud-era name and job label so the boot
 * wiring and the telemetry series stay where they are.
 *
 * The shape is jobs/studioAppConnectorSync.js's, for the same reasons: an
 * advisory lock keeps the replicas from scanning redundantly, an in-process
 * guard keeps a slow Nextcloud from stacking ticks, a per-tick LIMIT drains a
 * backlog over minutes rather than holding every other job, and a bounded
 * worker pool keeps one slow table from blocking the rest. What actually
 * prevents a double run is the per-row claim inside syncRows.
 */

'use strict';

const { pool } = require('../db');
const datatableStore = require('../stores/datatableStore');
const log = require('../telemetry/log');
const { createLockedTick, runWorkerPool } = require('./lib/workerPool');

const LOCK_KEY = 0xBEEF110;
const INTERVAL_MS = 60 * 1000;
const BOOT_DELAY_MS = 45 * 1000;
const MAX_PER_TICK = parseInt(process.env.DATATABLE_NC_SYNC_PER_TICK, 10) || 20;
const SYNC_CONCURRENCY = parseInt(process.env.DATATABLE_NC_SYNC_CONCURRENCY, 10) || 3;

let _timer = null;

/** Run one due mirror, whatever its kind. Exported for the tests. */
async function syncOne(table) {
    const sources = require('../core/dataEngine/sources');
    try {
        const result = await sources.syncRows(table, { reason: 'schedule' });
        return { ok: result.ok || !!result.alreadyRunning, result };
    } catch (e) {
        // syncRows records the error and schedules the retry itself; the job
        // only reports health.
        return { ok: false, error: e && e.message };
    }
}

// One tick: the advisory lock, the in-flight guard and the job-run metric
// live in jobs/lib/workerPool.js; a pool of workers pulls from one shared
// cursor so a fast item never waits on a slow one.
const processDueSyncs = createLockedTick({
    pool,
    lockKey: LOCK_KEY,
    job: 'datatable_nc_sync',
    label: 'DatatableNcSync',
    run: async () => {
        let ok = true;
        const due = await datatableStore.listDueSourceSyncs(MAX_PER_TICK);
        await runWorkerPool(due, SYNC_CONCURRENCY, async (item) => {
            const r = await syncOne(item);
            if (!r.ok) ok = false;
        });
        return ok;
    },
});

function start() {
    if (_timer) return;
    log.info(`[DatatableNcSync] started: every ${INTERVAL_MS / 1000}s, up to ${MAX_PER_TICK} per tick, ${SYNC_CONCURRENCY} at a time`);
    _timer = setInterval(() => {
        processDueSyncs().catch((e) => log.warn('[DatatableNcSync] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        processDueSyncs().catch((e) => log.warn('[DatatableNcSync] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

module.exports = { start, processDueSyncs, syncOne, LOCK_KEY, MAX_PER_TICK, SYNC_CONCURRENCY };
