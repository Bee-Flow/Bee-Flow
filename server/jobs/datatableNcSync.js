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
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF110;
const INTERVAL_MS = 60 * 1000;
const BOOT_DELAY_MS = 45 * 1000;
const MAX_PER_TICK = parseInt(process.env.DATATABLE_NC_SYNC_PER_TICK, 10) || 20;
const SYNC_CONCURRENCY = parseInt(process.env.DATATABLE_NC_SYNC_CONCURRENCY, 10) || 3;

let _inFlight = false;
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
        if (!acquired) return;

        const due = await datatableStore.listDueSourceSyncs(MAX_PER_TICK);
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
        log.warn('[DatatableNcSync] tick error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'datatable_nc_sync', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

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
