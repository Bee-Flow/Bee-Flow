// @typecheck strict
/**
 * App Studio server triggers: the job that fires them.
 *
 * A published app may carry triggers (appStudio/triggers/): each armed one is a row with the
 * time it is due. Every pass settles how the runs of earlier fires ended and fires the rows whose
 * time passed, on whichever replica takes the tick. What a pass does to a row, the rule for
 * missed fires and the back-off are in appStudio/triggers/triggerFire.mts.
 *
 * Safe on several replicas twice over: the tick sits behind a Postgres advisory lock (one
 * replica per pass), and every fire is a compare-and-set on the row, so a pass that races another
 * still fires a trigger exactly once.
 *
 * Every 30 s (STUDIO_APP_TRIGGER_INTERVAL_MS, at least 1 s), at most STUDIO_APP_TRIGGER_BATCH
 * fires per pass (default 50, 0 = unlimited), behind the apps module gate: with the module off
 * nothing fires, and when it comes back each trigger whose time passed fires once.
 *
 * The pass is handed in by whoever starts the job (boot/startupJobs.js): jobs/ sits below the
 * App Studio feature and does not require it (server/layering.test.js).
 */

'use strict';

const { pool } = require('../db');
const log = require('../telemetry/log');
const { createLockedTick } = require('./lib/workerPool');

const LOCK_KEY = 0xBEEF117;
const DEFAULT_INTERVAL_MS = 30 * 1000;
const MIN_INTERVAL_MS = 1000;
const BOOT_DELAY_MS = 25 * 1000;

/** @type {NodeJS.Timeout | null} */
let _timer = null;

/**
 * How often the job looks: STUDIO_APP_TRIGGER_INTERVAL_MS, never under a second; 30 s when unset or not a number.
 * @param {Record<string, string | undefined>} [env]
 */
function intervalMs(env = process.env) {
    const raw = env.STUDIO_APP_TRIGGER_INTERVAL_MS;
    const n = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_MS, Math.floor(n)) : DEFAULT_INTERVAL_MS;
}

/** @typedef {() => Promise<{ settled: number, due: number, fired: number, skipped: number, disarmed: number }>} Pass  one pass (appStudio/triggers/triggerFire.mts triggerPass) */

/**
 * One pass with the feature's `pass`.
 * @param {Pass} pass
 */
async function firePass(pass) {
    const out = await pass();
    if (out.due || out.settled) log.info(`[StudioAppTriggers] ${out.due} trigger(s) were due: ${out.fired} fired, ${out.skipped} skipped, ${out.disarmed} disarmed; ${out.settled} earlier run(s) settled`);
    return out;
}

/**
 * Mount the interval and the boot tick behind the runtime module gate. `pass` is the feature's
 * triggerPass; `gate` is a test seam.
 * @param {{ pass: Pass, gate?: Function }} opts
 */
function start({ pass, gate }) {
    if (_timer) return;
    const tick = createLockedTick({
        pool,
        lockKey: LOCK_KEY,
        job: 'studio_app_triggers',
        label: 'StudioAppTriggers',
        run: async () => { await firePass(pass); return true; },
    });
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('apps', tick, 'studioAppTriggers');
    _timer = setInterval(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppTriggers] tick error:', e && e.message));
    }, intervalMs());
    _timer.unref?.();
    setTimeout(() => {
        gatedTick().catch((/** @type {{ message?: unknown }} */ e) => log.warn('[StudioAppTriggers] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = { start, stop, firePass, intervalMs, LOCK_KEY };
