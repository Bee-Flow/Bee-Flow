// @typecheck strict
/**
 * OpenAI model catalog: the per-model facts as data (see ./openaiModels.js for
 * why they are data and not regexes, and for the functions that read them).
 * Split out of openaiModels.js so the table can grow without the logic file
 * growing with it. Dependency-free on purpose, like openaiModels.js.
 *
 * @typedef {{ name?: string, cat?: string, family?: string, desc?: string, context?: number,
 *   maxInput?: number, maxOutput?: number, efforts?: readonly string[] | null, defaultEffort?: string | null,
 *   vision?: boolean, tools?: boolean, toolsRequireResponses?: boolean, audio?: boolean,
 *   temperature?: boolean, verbosity?: boolean, cacheTtlParam?: string,
 *   price?: { input: number, cachedInput: number, output: number }, cutoff?: string, released?: string,
 *   deprecated?: { sunset: string, replacement: string } }} OpenAIModelEntry
 */

// ─── Reasoning-effort vocabularies ───────────────────────────────────────────
// An unsupported value is a hard 400, and the vocabularies genuinely differ per
// generation — this is the single most important thing in this file.

/** gpt-6: no `none` (400), no `minimal`; `max` is the new ceiling. */
const EFFORT_GPT6 = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** gpt-5.6+: `minimal` is gone, `xhigh`/`max` are generally available. */
const EFFORT_GPT56 = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
/** gpt-5.0 … gpt-5.5: has `minimal`, tops out at `high`. */
const EFFORT_GPT5 = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);
/** gpt-5.1-codex-max was the only pre-5.6 model that understood `xhigh`. */
const EFFORT_CODEX_MAX = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
/** Pro variants accept exactly one effort. */
const EFFORT_PRO = Object.freeze(['high']);
/** o-series: no `minimal` tier. */
const EFFORT_O_SERIES = Object.freeze(['none', 'low', 'medium', 'high']);

// ─── Prompt-cache TTL parameter ──────────────────────────────────────────────
// gpt-5.6+ take `prompt_cache_options: { ttl: '30m' }`; earlier models take
// `prompt_cache_retention: 'in_memory' | '24h'` (OpenAI's own default moved to
// '24h' on 2026-05-29). Sending the wrong one is rejected.
const CACHE_TTL_OPTIONS = 'options';
const CACHE_TTL_RETENTION = 'retention';

/**
 * The catalog.
 *
 * Field notes:
 *   efforts              — null means "not a reasoning model" (no `reasoning`
 *                          param, no `reasoning_effort`).
 *   toolsRequireResponses— true when Chat Completions accepts the model for
 *                          text but rejects tool calls (gpt-6-astra).
 *   temperature          — false when the model rejects temperature/top_p.
 *   verbosity            — the GPT-5-only output-length knob; dropped in 5.6+.
 *   price.cachedInput    — explicit per-model cached-read rate. Stored rather
 *                          than derived, because the discount is NOT uniform:
 *                          0.1x on the GPT-5/5.6/6 line, 0.25x on o4-mini,
 *                          0.5x on o3-mini.
 */
const OPENAI_MODELS = {
    // ── GPT-6 ────────────────────────────────────────────────────────────────
    'gpt-6-astra': {
        name: 'GPT-6 Astra', cat: 'Reasoning', family: 'gpt-6',
        desc: 'Most capable model, built for hard end-to-end work',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT6, defaultEffort: 'medium',
        vision: true, tools: true, toolsRequireResponses: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 10.0, cachedInput: 1.0, output: 50.0 },
        cutoff: '2026-04-30', released: '2026-09-03',
    },
    // Prices of the three below verified 2026-11-04 against OpenAI's list. No
    // release date is published for them; their training cutoff stands in for
    // it (see euUpliftApplies). Luna and Terra also accept `none` according to
    // OpenAI's model pages; they keep the gpt-6 vocabulary here, which rounds
    // `none` up to `low` instead of risking a 400 on a value we have not seen
    // a deployment accept.
    'gpt-6-luna': {
        name: 'GPT-6 Luna', cat: 'Reasoning', family: 'gpt-6',
        desc: 'Optimised for cost-sensitive workloads',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT6, defaultEffort: 'medium',
        vision: true, tools: true, toolsRequireResponses: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 0.10, cachedInput: 0.01, output: 0.50 },
        cutoff: '2026-05-18',
    },

    // ── GPT-6.1 ──────────────────────────────────────────────────────────────
    'gpt-6.1-sol': {
        name: 'GPT-6.1 Sol', cat: 'Reasoning', family: 'gpt-6.1',
        desc: 'Frontier model for complex reasoning and agentic work',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT6, defaultEffort: 'medium',
        vision: true, tools: true, toolsRequireResponses: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 2.0, cachedInput: 0.10, output: 10.0 },
        cutoff: '2026-04-30',
    },
    'gpt-6.1-terra': {
        name: 'GPT-6.1 Terra', cat: 'Reasoning', family: 'gpt-6.1',
        desc: 'Balances intelligence and cost',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT6, defaultEffort: 'medium',
        vision: true, tools: true, toolsRequireResponses: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 1.0, cachedInput: 0.05, output: 5.0 },
        cutoff: '2026-06-01',
    },

    // ── GPT-5.6 ──────────────────────────────────────────────────────────────
    'gpt-5.6-sol': {
        name: 'GPT-5.6 Sol', cat: 'Reasoning', family: 'gpt-5.6',
        desc: 'Frontier model for complex reasoning and agentic work',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT56, defaultEffort: 'medium',
        vision: true, tools: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 4.0, cachedInput: 0.40, output: 20.0 },
        released: '2026-07-09',
    },
    'gpt-5.6-terra': {
        name: 'GPT-5.6 Terra', cat: 'Reasoning', family: 'gpt-5.6',
        desc: 'Balances intelligence and cost',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT56, defaultEffort: 'medium',
        vision: true, tools: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 2.0, cachedInput: 0.20, output: 12.0 },
        cutoff: '2026-02-16', released: '2026-07-09',
    },
    'gpt-5.6-luna': {
        name: 'GPT-5.6 Luna', cat: 'Reasoning', family: 'gpt-5.6',
        desc: 'Optimised for cost-sensitive workloads',
        context: 1_050_000, maxInput: 922_000, maxOutput: 128_000,
        efforts: EFFORT_GPT56, defaultEffort: 'medium',
        vision: true, tools: true,
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_OPTIONS,
        price: { input: 0.20, cachedInput: 0.02, output: 1.20 },
        cutoff: '2026-02-16', released: '2026-07-09',
    },

    // ── GPT-5.0 … 5.5 ────────────────────────────────────────────────────────
    // Kept in the catalog so the 5.x-vs-5.6+ split is data, not a regex.
    'gpt-5.5': {
        name: 'GPT-5.5', cat: 'Reasoning', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_GPT5, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 5.0, cachedInput: 0.50, output: 30.0 },
    },
    'gpt-5.4': {
        name: 'GPT-5.4', cat: 'Reasoning', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_GPT5, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 2.50, cachedInput: 0.25, output: 15.0 },
    },
    'gpt-5.2': {
        name: 'GPT-5.2', cat: 'Reasoning', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_GPT5, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 1.75, cachedInput: 0.175, output: 14.0 },
    },
    'gpt-5.1': {
        name: 'GPT-5.1', cat: 'Reasoning', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_GPT5, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 1.25, cachedInput: 0.125, output: 10.0 },
    },
    'gpt-5': {
        name: 'GPT-5', cat: 'Reasoning', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_GPT5, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 1.25, cachedInput: 0.125, output: 10.0 },
    },
    'gpt-5.1-codex-max': {
        name: 'GPT-5.1 Codex Max', cat: 'Coding', family: 'gpt-5',
        context: 400_000, maxOutput: 128_000,
        efforts: EFFORT_CODEX_MAX, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: true,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },

    // ── o-series ─────────────────────────────────────────────────────────────
    'o3': {
        name: 'o3', cat: 'Reasoning', family: 'o-series',
        context: 400_000, maxOutput: 100_000,
        efforts: EFFORT_O_SERIES, defaultEffort: 'medium',
        vision: false, tools: true, temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 2.0, cachedInput: 0.50, output: 8.0 },
    },
    'o3-mini': {
        name: 'o3 Mini', cat: 'Reasoning', family: 'o-series',
        context: 200_000, maxOutput: 100_000,
        efforts: EFFORT_O_SERIES, defaultEffort: 'medium',
        vision: false, tools: true, temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 1.10, cachedInput: 0.55, output: 4.40 },
    },
    'o4-mini': {
        name: 'o4 Mini', cat: 'Reasoning', family: 'o-series',
        context: 200_000, maxOutput: 100_000,
        efforts: EFFORT_O_SERIES, defaultEffort: 'medium',
        vision: true, tools: true, temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
        price: { input: 1.10, cachedInput: 0.275, output: 4.40 },
    },

    // ── Non-reasoning (legacy GPT-4 line) ────────────────────────────────────
    // No `price` here on purpose: the community pricing database has carried
    // these for years, so there is nothing for a fallback to rescue.
    'gpt-4.1': {
        name: 'GPT-4.1', cat: 'Generalist', family: 'gpt-4.1',
        context: 400_000, maxOutput: 32_768,
        efforts: null, vision: true, tools: true,
        temperature: true, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },
    'gpt-4.1-mini': {
        name: 'GPT-4.1 Mini', cat: 'Generalist', family: 'gpt-4.1',
        context: 400_000, maxOutput: 32_768,
        efforts: null, vision: true, tools: true,
        temperature: true, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },
    'gpt-4.1-nano': {
        name: 'GPT-4.1 Nano', cat: 'Generalist', family: 'gpt-4.1',
        context: 400_000, maxOutput: 32_768,
        efforts: null, vision: true, tools: true,
        // nano variants reject custom temperature.
        temperature: false, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },
    'gpt-4o': {
        name: 'GPT-4o', cat: 'Generalist', family: 'gpt-4o',
        context: 128_000, maxOutput: 16_384,
        efforts: null, vision: true, tools: true,
        temperature: true, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },
    'gpt-4o-mini': {
        name: 'GPT-4o Mini', cat: 'Generalist', family: 'gpt-4o',
        context: 128_000, maxOutput: 16_384,
        efforts: null, vision: true, tools: true,
        temperature: true, verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    },

    // ── Audio / transcription ────────────────────────────────────────────────
    // Here for the deprecation data, not for chat.
    'whisper-1': {
        name: 'Whisper v1', cat: 'Audio', family: 'audio',
        efforts: null, audio: true, temperature: true,
        deprecated: { sunset: '2027-02-26', replacement: 'gpt-transcribe' },
    },
    'gpt-4o-transcribe': {
        name: 'GPT-4o Transcribe', cat: 'Audio', family: 'audio',
        efforts: null, audio: true, temperature: true,
        deprecated: { sunset: '2027-02-26', replacement: 'gpt-transcribe' },
    },
    'gpt-4o-mini-transcribe': {
        name: 'GPT-4o Mini Transcribe', cat: 'Audio', family: 'audio',
        efforts: null, audio: true, temperature: true,
        deprecated: { sunset: '2027-02-26', replacement: 'gpt-transcribe' },
    },
    'gpt-4o-transcribe-diarize': {
        name: 'GPT-4o Transcribe Diarize', cat: 'Audio', family: 'audio',
        efforts: null, audio: true, temperature: true,
        deprecated: { sunset: '2027-02-26', replacement: 'gpt-live-transcribe' },
    },
    'gpt-transcribe': {
        name: 'GPT Transcribe', cat: 'Audio', family: 'audio',
        efforts: null, audio: true, temperature: true,
    },
};

module.exports = {
    OPENAI_MODELS,
    EFFORT_GPT6,
    EFFORT_GPT56,
    EFFORT_GPT5,
    EFFORT_CODEX_MAX,
    EFFORT_PRO,
    EFFORT_O_SERIES,
    CACHE_TTL_OPTIONS,
    CACHE_TTL_RETENTION,
};
