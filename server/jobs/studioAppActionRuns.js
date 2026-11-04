// @typecheck strict
/**
 * App Studio background actions — the stale-run sweep.
 *
 * A background job runs inside one server process (appStudio/backgroundRun.mts) and beats its
 * run row every few seconds. When the process dies (a crash, a deploy that outlived the drain)
 * the row stops beating; this sweep marks such rows `interrupted` so the browser shows an end
 * and the row's lockKey is free again. There is no resume: steps are not idempotent.
 *
 * Every 60 s, behind a Postgres advisory lock (one replica per tick) and the apps module gate.
 * The prune of old rows lives in the ungated jobs/platformRetention.js (a retention duty must
 * not depend on a module being switched on).
 */

const { pool } = require('../db');
const log = require('../telemetry/log');
const { createLockedTick } = require('./lib/workerPool');

const LOCK_KEY = 0xBEEF114;
const INTERVAL_MS = 60 * 1000;
const BOOT_DELAY_MS = 30 * 1000;
const PER_TICK = 200;

/** @type {NodeJS.Timeout | null} */
let _timer = null;

/**
 * One pass: background rows nobody beats any more → interrupted. `deps` is the test seam.
 * @param {{ store?: { markStaleInterrupted: (staleMs: number, limit: number) => Promise<number> }, staleMs?: number }} [deps]
 */
async function sweepStaleRuns(deps = {}) {
    const store = deps.store || require('../stores/studioAppData/actionRuns.mts').actionRunStore();
    const stale = deps.staleMs ?? require('../stores/studioAppData/runPolicy.mts').staleMs();
    const n = await store.markStaleInterrupted(stale, PER_TICK);
    if (n) log.info(`[StudioAppActionRuns] marked ${n} stale background run(s) interrupted`);
    return n;
}

const tick = createLockedTick({
    pool,
    lockKey: LOCK_KEY,
    job: 'studio_app_action_runs',
    label: 'StudioAppActionRuns',
    run: async () => { await sweepStaleRuns(); return true; },
});

/**
 * Mount the interval and the boot tick behind the runtime module gate. `gate` is a test seam.
 * @param {{ gate?: Function }} [opts]
 */
function start({ gate } = {}) {
    if (_timer) return;
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('apps', tick, 'studioAppActionRuns');
    _timer = setInterval(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppActionRuns] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppActionRuns] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = { start, stop, sweepStaleRuns, LOCK_KEY, PER_TICK };
