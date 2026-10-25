// @typecheck strict
/**
 * Memory telemetry: every MEMORY_TELEMETRY_INTERVAL_MS (default 5 min) log the
 * process memory in MB, so a slowly growing server shows up in the logs before
 * the OOM killer finds it. 0 switches it off. The timer is unref'd.
 */

const log = require('../telemetry/log');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** @type {Array<keyof NodeJS.MemoryUsage>} */
const FIELDS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];

function intervalMs() {
    const raw = process.env.MEMORY_TELEMETRY_INTERVAL_MS;
    if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

/**
 * Process memory in whole MB, keyed like process.memoryUsage().
 * @param {NodeJS.MemoryUsage} [usage]
 */
function snapshot(usage = process.memoryUsage()) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const f of FIELDS) out[f] = Math.round((Number(usage[f]) || 0) / (1024 * 1024));
    return out;
}

function logOnce() {
    const m = snapshot();
    log.info(`[memory] rss=${m.rss}MB heapUsed=${m.heapUsed}MB heapTotal=${m.heapTotal}MB external=${m.external}MB arrayBuffers=${m.arrayBuffers}MB`);
    return m;
}

/** @type {NodeJS.Timeout | null} */
let _interval = null;

function start() {
    if (_interval) return;
    const ms = intervalMs();
    if (ms === 0) return;
    _interval = setInterval(logOnce, ms);
    if (typeof _interval.unref === 'function') _interval.unref();
}

function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { start, stop, logOnce, snapshot, intervalMs };
