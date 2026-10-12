/**
 * Solution stage deployments: the 15-second tick of the deploy runner
 * (projects/stages/runner.js, design 6.4).
 *
 * Every pod ticks; no advisory lock is needed, because every step a tick takes
 * is won by one replica in the database: a queued or approved row is CLAIMED
 * conditionally, an in-flight row whose lease ran out is RECLAIMED
 * conditionally, and an awaiting row is moved only out of `awaiting_approval`.
 * A tick:
 *
 *   1. reconciles awaiting approvals (a decision whose store call was lost);
 *   2. resumes in-flight rows whose worker died (compensate, or converge again);
 *   3. runs what is queued or approved (a kick the route made may have been
 *      lost with its process).
 *
 * Ticks never overlap within a process; tick() never throws.
 */

'use strict';

const log = require('../telemetry/log');

const TICK_MS = 15_000;
let _timer = null;
let _running = false;

/**
 * One tick over the given runner (default: the process's own).
 * @param {{ runner?: { tick: () => Promise<object> } }} [deps]
 * @returns {Promise<object|null>} the runner's summary, or null when a tick was still running
 */
async function tick(deps = {}) {
    if (_running) return null;
    _running = true;
    try {
        const runner = deps.runner || require('../projects/stages/runner').getRunner();
        return await runner.tick();
    } catch (err) {
        log.warn(`[SolutionDeployRunner] tick failed: ${err && err.message}`);
        return null;
    } finally {
        _running = false;
    }
}

/** @param {{ runner?: object, intervalMs?: number }} [deps] */
function start(deps = {}) {
    if (_timer) return;
    const ms = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : TICK_MS;
    _timer = setInterval(() => { tick(deps); }, ms);
    if (_timer.unref) _timer.unref();
    log.info(`[SolutionDeployRunner] Started — every ${Math.round(ms / 1000)} s`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, tick, TICK_MS };
