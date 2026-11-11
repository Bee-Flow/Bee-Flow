// @typecheck strict
/**
 * App Studio server runs: the wake job of runs on hold.
 *
 * A step of a server run may wait (appStudio/runPause.mts): its run row turns `paused` with a
 * wake time and no process holds it. This job continues the runs whose time passed, on
 * whichever replica takes the tick: the wait is over (the run goes on), or nothing resumed it in
 * time (its step fails with `pause_expired`). A run that may no longer go on (the app was
 * unpublished, its starter lost access, the action changed) is ended as `refused` here.
 *
 * Safe on several replicas twice over: the tick sits behind a Postgres advisory lock (one
 * replica per pass), and every resume is a compare-and-set on the row, so a pass that races a
 * person or a server-side resume still runs the rest of a run exactly once.
 *
 * Every 30 s (STUDIO_APP_RUN_WAKE_INTERVAL_MS, at least 1 s), at most STUDIO_APP_RUN_WAKE_BATCH
 * runs per pass (default 100, 0 = unlimited), behind the apps module gate.
 *
 * The runner is handed in by whoever starts the job (boot/startupJobs.js): jobs/ sits below the
 * App Studio feature and does not require it (server/layering.test.js).
 */

'use strict';

const { pool } = require('../db');
const log = require('../telemetry/log');
const { createLockedTick } = require('./lib/workerPool');

const LOCK_KEY = 0xBEEF116;
const DEFAULT_INTERVAL_MS = 30 * 1000;
const MIN_INTERVAL_MS = 1000;
const BOOT_DELAY_MS = 20 * 1000;

/** @type {NodeJS.Timeout | null} */
let _timer = null;

/**
 * How often the job looks: STUDIO_APP_RUN_WAKE_INTERVAL_MS, never under a second; 30 s when unset or not a number.
 * @param {Record<string, string | undefined>} [env]
 */
function intervalMs(env = process.env) {
    const raw = env.STUDIO_APP_RUN_WAKE_INTERVAL_MS;
    const n = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_MS, Math.floor(n)) : DEFAULT_INTERVAL_MS;
}

/** @typedef {() => Promise<{ due: number, resumed: number }>} Wake  continue the due runs (appStudio/backgroundRun.mts wakeDueRuns) */

/**
 * One pass with the runner's `wake`.
 * @param {Wake} wake
 */
async function wakePass(wake) {
    const out = await wake();
    if (out.due) log.info(`[StudioAppRunWake] ${out.due} run(s) on hold were due, ${out.resumed} continued`);
    return out;
}

/**
 * Mount the interval and the boot tick behind the runtime module gate. `wake` is the runner's
 * wakeDueRuns; `gate` is a test seam.
 * @param {{ wake: Wake, gate?: Function }} opts
 */
function start({ wake, gate }) {
    if (_timer) return;
    const tick = createLockedTick({
        pool,
        lockKey: LOCK_KEY,
        job: 'studio_app_run_wake',
        label: 'StudioAppRunWake',
        run: async () => { await wakePass(wake); return true; },
    });
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('apps', tick, 'studioAppRunWake');
    _timer = setInterval(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppRunWake] tick error:', e && e.message));
    }, intervalMs());
    _timer.unref?.();
    setTimeout(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppRunWake] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = { start, stop, wakePass, intervalMs, LOCK_KEY };
