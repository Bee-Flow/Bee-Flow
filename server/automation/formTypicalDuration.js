// @typecheck strict
/**
 * formTypicalDuration.js — "this usually takes about N seconds".
 *
 * The public form poll shows a visitor who waits on the automation how long
 * the wait usually is. The figure is the median duration of the automation's
 * last 20 live, non-test run legs, as ONE aggregate integer: no run, no
 * payload, no person is reachable through it.
 *
 * Cached per automation for five minutes (the poll fires every second or two
 * per visitor) and bounded in size. A failure is never the visitor's problem:
 * no figure, no hint.
 */

const log = require('../telemetry/log');

const MIN_SAMPLES = 3;
const SAMPLE_LIMIT = 20;
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

/** @type {Map<string, { value: number|null, at: number }>} */
const cache = new Map();

/**
 * @param {number[]} values
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {string} id
 * @param {number | null} value
 * @param {number} now
 */
function remember(id, value, now) {
    // Re-insert so the Map's insertion order is also the age order.
    cache.delete(id);
    cache.set(id, { value, at: now });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/**
 * The default reader. Required at call time: the store pulls in the whole
 * automation surface.
 * @param {string} id
 * @param {{ limit: number }} opts
 * @returns {Promise<number[]>}
 */
function defaultRead(id, opts) {
    return require('../stores/automationStore').recentLegDurations(id, opts);
}

/**
 * @param {string} automationId
 * @param {{ read?: (id: string, opts: { limit: number }) => Promise<number[]> }} [deps] injected reader (tests)
 * @returns {Promise<number|null>} whole seconds (>= 1), or null when there is no honest figure
 */
async function typicalSeconds(automationId, { read = defaultRead } = {}) {
    if (!automationId) return null;
    const id = String(automationId);
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    try {
        const samples = await read(id, { limit: SAMPLE_LIMIT });
        const usable = (Array.isArray(samples) ? samples : []).filter((v) => Number.isFinite(v) && v > 0);
        const value = usable.length < MIN_SAMPLES ? null : Math.max(1, Math.round(median(usable) / 1000));
        remember(id, value, now);
        return value;
    } catch (e) {
        log.debug(`[automation/form] typical duration unavailable: ${/** @type {Error} */ (e).message}`);
        return null;
    }
}

function _resetForTests() { cache.clear(); }

module.exports = { typicalSeconds, _resetForTests };
