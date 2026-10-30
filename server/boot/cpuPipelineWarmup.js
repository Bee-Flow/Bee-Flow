// @typecheck strict
/**
 * The warmups of the in-process CPU models (the bge-reranker-base
 * cross-encoder, the multilingual-e5-small embedder, Whisper-base), off the
 * boot path and only for a model a request can reach and has reached lately.
 *
 * WHY THE DELAY. Transformers.js builds its onnxruntime session on the main
 * thread, and on a small host that takes seconds: bge-reranker-base alone
 * blocks the event loop ~3 s on two SMT cores, the three together 3–7 s.
 * Started the moment the listener is up, the three loads land in the same
 * seconds the 101 store inits, the boot migrations, the durable-secret
 * bootstraps and the first requests need the database, and every query in
 * flight during a block waits on a connection the blocked process cannot
 * release. On a 2 vCPU / 8 GB host that is a hundred queries at the 5 s pool
 * timeout per boot, a schema ledger that reads as unreachable so every store
 * runs its full schema, and share-token secrets that never bootstrap, so
 * every public link dies on the next restart. On a faster host the same block
 * stays under 5 s and nobody notices.
 *
 * WHY THE SELECTION. A warmup is only worth its block when a request will
 * reach the model: an install with Azure embeddings and a cloud reranker
 * never calls the CPU fallbacks, and a customer that never transcribes never
 * calls Whisper. So with CPU_PIPELINES_PREWARM=auto (default) a model is
 * warmed when the configuration routes to it (the CPU tier is the one a KB
 * search / embedding / transcription takes) AND it served a request in the
 * last CPU_PIPELINES_PREWARM_DAYS days (core/llm/cpuPipelineUsage.js); `all`
 * warms every model the configuration routes to; `false` warms none.
 * LOCAL_WHISPER_PREWARM=false keeps Whisper out whatever the setting.
 *
 * The warmups start CPU_PIPELINES_PREWARM_DELAY_MS after boot (30 s: the
 * store inits and the secret bootstraps are long done) and run one at a time,
 * so a block never stacks on another. A model that is not warmed loads on its
 * first real request: a cold first call, never a wrong answer.
 */

'use strict';

const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');
const { PIPELINES, readLastUsed, usedWithin } = require('../core/llm/cpuPipelineUsage');

const DEFAULT_DELAY_MS = 30_000;
const DEFAULT_DAYS = 30;

/** @typedef {import('../core/llm/cpuPipelineUsage').Pipeline} Pipeline */
/** @typedef {import('../core/llm/cpuPipelineUsage').LastUsed} LastUsed */
/** @typedef {Record<Pipeline, boolean>} Reachable */
/** @typedef {Record<Pipeline, () => Promise<unknown>>} Warmers */
/** @typedef {'auto' | 'all' | 'off'} PrewarmMode */

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ mode: PrewarmMode, delayMs: number, days: number }}
 */
function readPrewarmSettings(env) {
    const raw = String(env.CPU_PIPELINES_PREWARM || 'auto').trim().toLowerCase();
    /** @type {PrewarmMode} */
    const mode = raw === 'false' || raw === '0' || raw === 'off' || raw === 'none' ? 'off'
        : raw === 'all' || raw === 'true' ? 'all'
            : 'auto';
    const delayMs = Number(env.CPU_PIPELINES_PREWARM_DELAY_MS);
    const days = Number(env.CPU_PIPELINES_PREWARM_DAYS);
    return {
        mode,
        delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_DELAY_MS,
        days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS,
    };
}

/**
 * Which models to warm, and why not the others.
 *
 * @param {{ mode: PrewarmMode, days: number, now: number, reachable: Reachable, lastUsed: LastUsed }} input
 * @returns {{ warm: Pipeline[], skipped: Record<Pipeline, string> }} per skipped model the reason
 */
function planCpuWarmups({ mode, days, now, reachable, lastUsed }) {
    /** @type {Pipeline[]} */
    const warm = [];
    /** @type {Record<Pipeline, string>} */
    const skipped = { rerank: '', embed: '', whisper: '' };
    for (const name of PIPELINES) {
        if (mode === 'off') { skipped[name] = 'CPU_PIPELINES_PREWARM=false'; continue; }
        if (!reachable[name]) { skipped[name] = 'another provider is configured'; continue; }
        if (mode === 'auto' && !usedWithin(lastUsed, name, days, now)) {
            skipped[name] = lastUsed[name] === null ? 'never used' : `not used in the last ${days} days`;
            continue;
        }
        warm.push(name);
    }
    return { warm, skipped };
}

/**
 * Warm `names` one after the other. A warmup that rejects is logged and the
 * next one still runs; nothing here ever throws.
 *
 * @param {Pipeline[]} names
 * @param {Warmers} warmers
 * @param {Pick<typeof log, 'info' | 'warn'>} logger
 */
async function runCpuWarmups(names, warmers, logger) {
    for (const name of names) {
        const t0 = Date.now();
        try {
            await warmers[name]();
            logger.info(`[CpuPipelines] ${name} warm in ${Date.now() - t0} ms`);
        } catch (err) {
            logger.warn(`[CpuPipelines] ${name} warmup failed: ${/** @type {Error} */ (err).message}`);
        }
    }
}

/**
 * The CPU tiers as the current configuration would route to them. Read when
 * the warmup fires, not at boot, so an admin change in between counts.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Reachable>}
 */
async function readReachability(env) {
    const configStore = require('../stores/configStore');
    const { readRerankTierInputs, cpuTierConfigured } = require('../core/kb/localRerank');
    const { isEnabled: llamaCppRerankEnabled } = require('../core/rerank/llamaCppRerank');
    const { readWebSearchInferenceConfig } = require('../core/llm/webSearchInferenceResolver');
    const { cpuEmbedderConfigured } = require('../core/embed/dispatch');
    const { isModuleAvailable } = require('../modules/catalog');

    const kbSearchReachesCpu = cpuTierConfigured({
        ...(await readRerankTierInputs(configStore)),
        llamaCppEnabled: await llamaCppRerankEnabled(),
    });
    const webSearchReachesCpu = (await readWebSearchInferenceConfig()).rerank.method === 'cpu';
    return {
        rerank: kbSearchReachesCpu || webSearchReachesCpu,
        embed: await cpuEmbedderConfigured(),
        whisper: env.LOCAL_WHISPER_PREWARM !== 'false' && isModuleAvailable('meetingNotes'),
    };
}

/** @returns {Warmers} */
function defaultWarmers() {
    return {
        rerank: () => require('../core/rerank/cpuCrossEncoder').warmup(),
        embed: () => require('../core/embed/cpuEmbed').warmup(),
        whisper: () => require('../core/voice/localWhisper').warmLocalWhisper(),
    };
}

/**
 * Decide and run, once. Exposed for the test and for the scheduler below.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => number, reachable?: () => Promise<Reachable>,
 *           lastUsed?: () => Promise<LastUsed>, warmers?: Warmers,
 *           log?: Pick<typeof log, 'info' | 'warn'> }} [deps]
 * @returns {Promise<Pipeline[]>} the models that were warmed
 */
async function warmCpuPipelinesNow(deps = {}) {
    const env = deps.env || process.env;
    const logger = deps.log || log;
    const { mode, days } = readPrewarmSettings(env);
    if (mode === 'off') {
        logger.info('[CpuPipelines] warmups off (CPU_PIPELINES_PREWARM=false); models load on first use');
        return [];
    }
    /** @type {Reachable} */
    let reachable;
    /** @type {LastUsed} */
    let lastUsed;
    try {
        reachable = await (deps.reachable || (() => readReachability(env)))();
        lastUsed = mode === 'all'
            ? { rerank: null, embed: null, whisper: null }
            : await (deps.lastUsed || (() => readLastUsed()))();
    } catch (err) {
        // Unknown is not "warm everything": the lazy load on first use is the
        // safe answer, and it costs one cold request at most.
        logger.warn(`[CpuPipelines] could not read the model settings, warming nothing: ${/** @type {Error} */ (err).message}`);
        return [];
    }
    const { warm, skipped } = planCpuWarmups({ mode, days, now: deps.now ? deps.now() : Date.now(), reachable, lastUsed });
    const skippedText = PIPELINES.filter((n) => skipped[n]).map((n) => `${n} (${skipped[n]})`).join(', ');
    logger.info(`[CpuPipelines] warming: ${warm.length ? warm.join(', ') : 'nothing'}${skippedText ? `; skipped: ${skippedText}` : ''}`);
    await runCpuWarmups(warm, deps.warmers || defaultWarmers(), logger);
    return warm;
}

/**
 * Boot entry: schedule warmCpuPipelinesNow after the delay. Never throws, and
 * the timer never keeps the process alive.
 *
 * @param {Parameters<typeof warmCpuPipelinesNow>[0] & { setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown }} [deps]
 */
function startCpuPipelineWarmups(deps = {}) {
    const env = deps.env || process.env;
    const { delayMs } = readPrewarmSettings(env);
    const setTimer = deps.setTimer || setTimeout;
    const t = setTimer(() => {
        warmCpuPipelinesNow(deps).catch((e) => bestEffort('boot/cpuPipelineWarmup:startCpuPipelineWarmups', e));
    }, delayMs);
    if (t && typeof t === 'object' && 'unref' in t && typeof t.unref === 'function') t.unref();
}

module.exports = {
    startCpuPipelineWarmups,
    warmCpuPipelinesNow,
    planCpuWarmups,
    runCpuWarmups,
    readPrewarmSettings,
    readReachability,
    DEFAULT_DELAY_MS,
    DEFAULT_DAYS,
};
