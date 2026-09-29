// @typecheck
/**
 * OpenAI model catalog — capabilities, limits and list prices.
 *
 * Why this file exists: until now every OpenAI fact lived as a regex, scattered
 * over the adapter (`/^gpt-5/` for reasoning, `/nano/` for temperature),
 * openaiModelCaps (`/codex-max/` for xhigh), contextPolicy (400k for
 * `gpt-5|gpt-4.1|o[34]`), modelResolver and three frontend copies. That worked
 * while the family was one shape. It stopped working the moment OpenAI shipped
 * a generation with a DIFFERENT parameter vocabulary — gpt-5.6 dropped
 * `minimal` and added `max`, gpt-6 additionally dropped `none` and refuses
 * `temperature` outright — because a regex can only say "looks like GPT-5", not
 * "accepts this effort value".
 *
 * So the per-model facts live here as data, in the same spirit as
 * ./scalewayModels.js and ./localModels.js, and for the same three jobs:
 *
 *  1. CATALOG — id → display name, category, context window, output cap,
 *     capability flags. `/v1/models` hands back bare ids and nothing else.
 *
 *  2. REQUEST SHAPING FACTS — per-model reasoning-effort vocabulary, whether
 *     `temperature` / `verbosity` are accepted at all, whether tool calls
 *     require the Responses API, and which prompt-cache TTL parameter the
 *     model speaks. Every one of these is a 400 when you get it wrong.
 *
 *  3. LIST PRICES — fallback tariffs for modelCosts, so a model the community
 *     pricing database has not picked up yet is billed at its real rate instead
 *     of falling through to the upper-bound guess (which is the most expensive
 *     rate of every model we know, and lands on real PAYG invoices).
 *
 * Dependency-free on purpose: this is required from the adapter, from cost
 * accounting and from route handlers, so it must not pull in anything that
 * could cycle.
 *
 * Catalog verified 2026-09-15 against https://developers.openai.com/api/docs/models
 * and .../pricing. Prices are USD per 1M tokens.
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

// ─── Endpoints ───────────────────────────────────────────────────────────────
// OpenAI terminates TLS and runs inference inside the selected region on the
// prefixed domains. For a GDPR product the EU one is the interesting part: it
// keeps prompt content out of US processing entirely, which is a different and
// stronger claim than "we have a DPA".
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_EU_BASE_URL = 'https://eu.api.openai.com/v1';

/** Regional-processing endpoints carry a 10% uplift on eligible models. */
const EU_RESIDENCY_UPLIFT = 1.10;
/** Models released on or after this date are the ones the uplift applies to. */
const EU_UPLIFT_FROM = '2026-03-05';

/** Is this base URL an OpenAI regional-processing endpoint in the EU? */
function isEuResidencyUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        return new URL(url).hostname.toLowerCase() === 'eu.api.openai.com';
    } catch (_) {
        return /(^|\/\/)eu\.api\.openai\.com/i.test(url);
    }
}

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

/**
 * Aliases OpenAI publishes alongside the concrete snapshot ids.
 * `gpt-5.6` resolves to Sol, the frontier member of that family.
 */
const MODEL_ALIASES = Object.freeze({
    'gpt-5.6': 'gpt-5.6-sol',
    'gpt-6': 'gpt-6-astra',
});

// Pro variants are locked to a single effort; codex-max had xhigh before 5.6.
const PRO_MODEL = /^gpt-5(\.\d+)?-pro$/;
const CODEX_MAX = /codex-max/;

/**
 * Canonicalise a model id: drop any `openai/` routing prefix, lowercase, and
 * resolve a published alias to its concrete id. Snapshot suffixes
 * (`-2026-04-30`) are stripped so a dated pin still finds its catalog entry.
 */
function normalizeOpenAIModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    let id = modelId.trim().toLowerCase();
    const slash = id.lastIndexOf('/');
    if (slash >= 0) id = id.slice(slash + 1);
    if (MODEL_ALIASES[id]) return MODEL_ALIASES[id];
    if (OPENAI_MODELS[id]) return id;
    // Dated snapshot pin, e.g. gpt-5.6-terra-2026-02-16.
    const undated = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (OPENAI_MODELS[undated]) return undated;
    if (MODEL_ALIASES[undated]) return MODEL_ALIASES[undated];
    return id;
}

/** Raw catalog entry for an id, or null when it is not a model we know. */
function getOpenAIModel(modelId) {
    return OPENAI_MODELS[normalizeOpenAIModelId(modelId)] || null;
}

/**
 * Parse `gpt-<major>[.<minor>]` into comparable numbers.
 * This is what makes the fallback future-proof: gpt-5.7 and gpt-7 do not exist
 * yet, but they will, and they will follow their generation's rules rather than
 * whatever regex happened to be written today.
 *
 * @returns {{major:number, minor:number}|null}
 */
function _parseGptVersion(id) {
    const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
    if (!m) return null;
    return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * Capability profile for an id the catalog does not list.
 *
 * Deliberately generation-aware rather than "looks like GPT-5": an unknown
 * gpt-6.x must not inherit gpt-5's `minimal`/`temperature` assumptions, because
 * both are 400s there.
 */
function _guessProfile(id) {
    const v = _parseGptVersion(id);

    if (v && (v.major > 6 || (v.major === 6 && v.minor >= 0))) {
        // gpt-6 and later.
        return {
            cat: 'Reasoning', family: `gpt-${v.major}`,
            context: 1_050_000, maxOutput: 128_000,
            efforts: EFFORT_GPT6, defaultEffort: 'medium',
            vision: true, tools: true, toolsRequireResponses: true,
            temperature: false, verbosity: false,
            cacheTtlParam: CACHE_TTL_OPTIONS,
        };
    }
    if (v && v.major === 5 && v.minor >= 6) {
        // gpt-5.6 and later within the 5 line.
        return {
            cat: 'Reasoning', family: 'gpt-5.6',
            context: 1_050_000, maxOutput: 128_000,
            efforts: EFFORT_GPT56, defaultEffort: 'medium',
            vision: true, tools: true, toolsRequireResponses: false,
            temperature: false, verbosity: false,
            cacheTtlParam: CACHE_TTL_OPTIONS,
        };
    }
    if (v && v.major === 5) {
        return {
            cat: 'Reasoning', family: 'gpt-5',
            context: 400_000, maxOutput: 128_000,
            efforts: CODEX_MAX.test(id) ? EFFORT_CODEX_MAX : EFFORT_GPT5,
            defaultEffort: 'medium',
            vision: true, tools: true, toolsRequireResponses: false,
            temperature: false, verbosity: true,
            cacheTtlParam: CACHE_TTL_RETENTION,
        };
    }
    if (/^o\d/.test(id)) {
        return {
            cat: 'Reasoning', family: 'o-series',
            context: 200_000, maxOutput: 100_000,
            efforts: EFFORT_O_SERIES, defaultEffort: 'medium',
            vision: /^o4/.test(id), tools: true, toolsRequireResponses: false,
            temperature: false, verbosity: false,
            cacheTtlParam: CACHE_TTL_RETENTION,
        };
    }
    // Everything else: a non-reasoning chat model. `/nano/` keeps the
    // long-standing rule that nano variants reject custom temperature.
    return {
        cat: 'Generalist', family: v ? `gpt-${v.major}` : 'other',
        context: 128_000, maxOutput: 16_384,
        efforts: null, defaultEffort: null,
        vision: /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision/.test(id),
        tools: true, toolsRequireResponses: false,
        temperature: !/nano/.test(id), verbosity: false,
        cacheTtlParam: CACHE_TTL_RETENTION,
    };
}

/**
 * Describe an OpenAI model. ALWAYS returns an object — a model OpenAI ships
 * tomorrow gets its generation's profile rather than `undefined`, which is the
 * whole point: the adapter must be able to ask "does this accept temperature"
 * about an id it has never seen.
 *
 * `known` says whether the answer came from the catalog or from the generation
 * fallback, so callers that want to be cautious (pricing, for one) can tell.
 */
function describeOpenAIModel(modelId) {
    const id = normalizeOpenAIModelId(modelId);
    const entry = OPENAI_MODELS[id];
    const base = entry || _guessProfile(id);
    const pro = PRO_MODEL.test(id);

    return {
        id,
        known: !!entry,
        name: base.name || id,
        cat: base.cat || 'Generalist',
        desc: base.desc || '',
        family: base.family || 'other',
        context: base.context ?? null,
        maxInput: base.maxInput ?? null,
        maxOutput: base.maxOutput ?? null,
        // Pro variants accept exactly one effort, whatever their generation
        // otherwise offers — so the lock lives here rather than in every caller.
        efforts: pro ? EFFORT_PRO : (base.efforts || null),
        defaultEffort: pro ? 'high' : (base.defaultEffort || null),
        reasoning: pro || !!base.efforts,
        vision: !!base.vision,
        tools: base.tools !== false,
        toolsRequireResponses: !!base.toolsRequireResponses,
        audio: !!base.audio,
        temperature: base.temperature !== false,
        verbosity: !!base.verbosity,
        cacheTtlParam: base.cacheTtlParam || CACHE_TTL_RETENTION,
        price: base.price || null,
        cutoff: base.cutoff || null,
        released: base.released || null,
        deprecated: base.deprecated || null,
        pro,
    };
}

/** Does this model accept `effort` as a reasoning-effort value? */
function supportsEffort(modelId, effort) {
    const { efforts } = describeOpenAIModel(modelId);
    return !!efforts && efforts.includes(effort);
}

/** Context window (max input tokens), or null when we have no figure. */
function contextWindowFor(modelId) {
    return describeOpenAIModel(modelId).context;
}

/**
 * List price per 1M tokens, `{ input, cachedInput, output }`, or null.
 * Only catalog entries have one — a guessed profile must never invent a tariff.
 */
function getOpenAIListPrice(modelId) {
    const entry = getOpenAIModel(modelId);
    return entry?.price || null;
}

/**
 * Every catalog id that carries a list price, as `{ id, input, output, cacheRead }`
 * in the shape pricingService's FALLBACK_PRICING expects.
 */
function listPricedModels() {
    const out = {};
    for (const [id, entry] of Object.entries(OPENAI_MODELS)) {
        if (!entry.price) continue;
        out[id] = {
            input: entry.price.input,
            output: entry.price.output,
            cacheRead: entry.price.cachedInput,
        };
    }
    return out;
}

/**
 * Does the EU regional-processing uplift apply to this model?
 *
 * The uplift covers models released on or after 2026-03-05. A model we do not
 * recognise is assumed to be new — under-billing a customer is worse than
 * over-billing by 10%, and a genuinely old model is in the catalog.
 */
function euUpliftApplies(modelId) {
    const entry = getOpenAIModel(modelId);
    if (!entry) return true;
    if (!entry.released) return false;
    return entry.released >= EU_UPLIFT_FROM;
}

// ─── EU-served model registry ────────────────────────────────────────────────
// Which model ids are currently answered by an EU regional-processing endpoint.
// Same pattern, and same reason, as the Scaleway and local registries: cost
// accounting runs far from the provider record and would otherwise have no way
// to know the call carried the uplift. Populated by getProviderForModel on
// every resolution, so it is warm before any cost is computed.
const _euServedModels = new Set();

function registerEuServedModel(modelId) {
    const id = normalizeOpenAIModelId(modelId);
    if (id) _euServedModels.add(id);
}

function unregisterEuServedModel(modelId) {
    const id = normalizeOpenAIModelId(modelId);
    if (id) _euServedModels.delete(id);
}

function isEuServedModel(modelId) {
    return _euServedModels.has(normalizeOpenAIModelId(modelId));
}

function _resetEuServedRegistry() {
    _euServedModels.clear();
}

/** Retirement notice for a model, or null. */
function getDeprecation(modelId) {
    return getOpenAIModel(modelId)?.deprecated || null;
}

/** The catalog, described — for admin surfaces and tests. */
function listCatalogModels() {
    return Object.keys(OPENAI_MODELS).map(id => describeOpenAIModel(id));
}

module.exports = {
    OPENAI_MODELS,
    OPENAI_BASE_URL,
    OPENAI_EU_BASE_URL,
    EU_RESIDENCY_UPLIFT,
    EU_UPLIFT_FROM,
    isEuResidencyUrl,
    euUpliftApplies,
    registerEuServedModel,
    unregisterEuServedModel,
    isEuServedModel,
    _resetEuServedRegistry,
    MODEL_ALIASES,
    EFFORT_GPT6,
    EFFORT_GPT56,
    EFFORT_GPT5,
    EFFORT_CODEX_MAX,
    EFFORT_PRO,
    EFFORT_O_SERIES,
    CACHE_TTL_OPTIONS,
    CACHE_TTL_RETENTION,
    normalizeOpenAIModelId,
    getOpenAIModel,
    describeOpenAIModel,
    supportsEffort,
    contextWindowFor,
    getOpenAIListPrice,
    listPricedModels,
    getDeprecation,
    listCatalogModels,
};
