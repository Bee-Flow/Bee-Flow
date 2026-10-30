// @typecheck strict
/**
 * When each in-process CPU model (the reranker, the embedder, Whisper) last
 * served a real request: configStore key `cpu_pipeline_last_used`, one
 * timestamp per pipeline.
 *
 * WHY. Building an onnxruntime session runs on the main thread and takes
 * seconds on a small host (bge-reranker-base alone: ~3 s on two SMT cores).
 * Warming all three at boot, whether or not a request could ever reach them,
 * costs a customer that never transcribes and never web-searches three model
 * loads on every restart, in the very window the store inits and the secret
 * bootstraps need the database. boot/cpuPipelineWarmup.js therefore warms
 * only a model that served a request lately; the first real call loads a cold
 * model lazily, which is the normal path for a model that is not warmed.
 *
 * A warmup never marks (it is not a request). Writes are throttled to one per
 * pipeline per hour and are best-effort: a lost write costs one cold start.
 */

'use strict';

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const CONFIG_KEY = 'cpu_pipeline_last_used';
const PIPELINES = /** @type {const} */ (['rerank', 'embed', 'whisper']);
const WRITE_INTERVAL_MS = 60 * 60 * 1000;

/** @typedef {typeof PIPELINES[number]} Pipeline */
/** @typedef {Record<Pipeline, number | null>} LastUsed epoch ms per pipeline, null = never */
/** @typedef {{ mutateConfig: (key: string, fn: (cur: unknown) => unknown) => Promise<unknown>, getConfig: (key: string) => Promise<unknown> }} UsageStore */

/** @type {Map<string, number>} last write per pipeline, this process */
const lastWriteAt = new Map();

/** @param {unknown} name */
function isPipeline(name) {
    return typeof name === 'string' && /** @type {readonly string[]} */ (PIPELINES).includes(name);
}

/** @returns {UsageStore} */
function defaultStore() {
    return require('../../stores/configStore');
}

/**
 * Parse the stored blob; anything that is not an ISO timestamp counts as never.
 * @param {unknown} raw
 * @returns {LastUsed}
 */
function parseLastUsed(raw) {
    const obj = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    /** @type {LastUsed} */
    const out = { rerank: null, embed: null, whisper: null };
    for (const name of PIPELINES) {
        const v = obj[name];
        const ms = typeof v === 'string' ? Date.parse(v) : NaN;
        out[name] = Number.isFinite(ms) ? ms : null;
    }
    return out;
}

/**
 * Record that `name` served a real request now. Never throws, never blocks the
 * caller: the write runs in the background and is dropped on any failure.
 *
 * @param {Pipeline} name
 * @param {{ store?: UsageStore, now?: () => number }} [deps]
 * @returns {Promise<void>}
 */
async function markUsed(name, deps = {}) {
    if (!isPipeline(name)) return;
    const now = deps.now ? deps.now() : Date.now();
    const last = lastWriteAt.get(name);
    if (last !== undefined && now - last < WRITE_INTERVAL_MS) return;
    lastWriteAt.set(name, now);
    try {
        const store = deps.store || defaultStore();
        const stamp = new Date(now).toISOString();
        await store.mutateConfig(CONFIG_KEY, (cur) => {
            const base = cur && typeof cur === 'object' ? /** @type {Record<string, unknown>} */ (cur) : {};
            return { ...base, [name]: stamp };
        });
    } catch (err) {
        // Next call after the interval tries again.
        lastWriteAt.delete(name);
        bestEffort('core/llm/cpuPipelineUsage:markUsed', err);
        log.debug(`[CpuPipelines] could not record use of ${name}:`, /** @type {Error} */ (err).message);
    }
}

/**
 * @param {{ store?: UsageStore }} [deps]
 * @returns {Promise<LastUsed>}
 */
async function readLastUsed(deps = {}) {
    const store = deps.store || defaultStore();
    return parseLastUsed(await store.getConfig(CONFIG_KEY));
}

/**
 * Did `name` serve a request in the last `days` days?
 * @param {LastUsed} lastUsed
 * @param {Pipeline} name
 * @param {number} days
 * @param {number} [now] epoch ms
 */
function usedWithin(lastUsed, name, days, now = Date.now()) {
    const at = lastUsed[name];
    if (at === null || at === undefined) return false;
    return now - at <= days * 24 * 60 * 60 * 1000;
}

module.exports = {
    CONFIG_KEY,
    PIPELINES,
    markUsed,
    readLastUsed,
    usedWithin,
    parseLastUsed,
    _resetForTests: () => { lastWriteAt.clear(); },
};
