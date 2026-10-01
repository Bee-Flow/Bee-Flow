/**
 * One normaliser for what a provider reports as token usage.
 *
 * Every adapter used to translate its own provider's usage block (or, on the
 * non-streaming Claude and Gemini paths, did not translate it at all and handed
 * the raw block to callers that only read `prompt_tokens` / `completion_tokens`,
 * which logged those calls as zero tokens at zero cost with the cache lost).
 * Everything now goes through `normalizeUsage`, and every consumer that writes
 * a usage row reads the one shape below.
 *
 * Normalised shape (all counts are non-negative integers):
 *
 *   prompt_tokens               input tokens as the provider reports them. THE
 *                               SEMANTICS DIFFER, see `prompt_includes_cache`.
 *   completion_tokens           output tokens, reasoning/thinking included
 *                               (billed at the output rate).
 *   total_tokens
 *   cached_tokens               input tokens served from cache (cache READ).
 *   cache_creation_tokens       input tokens written to cache. Anthropic only
 *                               (OpenAI/Gemini report no write count).
 *   cache_creation_5m_tokens    the 5-minute-TTL part of the write ...
 *   cache_creation_1h_tokens    ... and the 1-hour-TTL part. They always sum to
 *                               `cache_creation_tokens`, so a mixed write can be
 *                               priced per part (1.25x vs 2x input) instead of
 *                               attributing it all to one "dominant" TTL.
 *   cache_creation_ttl_assumed  true when Anthropic reported a write total
 *                               without the per-TTL breakdown and the remainder
 *                               was attributed to 1h (extractSystem in claude.js
 *                               places a 1h breakpoint on the system prompt).
 *   reasoning_tokens            the reasoning share of `completion_tokens`
 *                               (informational: already billed as output).
 *                               Anthropic does not report it separately -> 0.
 *   prompt_includes_cache       false for Anthropic (`input_tokens` is ALREADY the
 *                               uncached remainder, cache read/write are
 *                               reported next to it), true for OpenAI, Azure,
 *                               Mistral, Scaleway, local runtimes and Gemini
 *                               (`prompt_tokens` is the full input and the cached
 *                               count is a subset of it). modelCosts
 *                               `_uncachedInputTokens` applies the same rule by
 *                               model name; this flag lets later code stop
 *                               guessing from the name.
 *   service_tier                the tier the provider actually billed
 *                               (Anthropic usage.service_tier, OpenAI
 *                               response.service_tier), else null.
 *   inference_geo               Anthropic usage.inference_geo, else null.
 *   traffic_type                Vertex usageMetadata.trafficType, else null.
 *   tool_use                    {web_search_requests, web_fetch_requests, ...}
 *                               server-side tool counts (Anthropic
 *                               server_tool_use, Gemini grounding searches) and
 *                               `prompt_tokens` for Gemini
 *                               toolUsePromptTokenCount (already INCLUDED in
 *                               `prompt_tokens`: it is billed as input).
 *   modality                    {prompt, completion, cached}: per-modality token
 *                               counts ({text, image, audio, video, document},
 *                               only the non-zero ones), from Gemini's
 *                               *TokensDetails and OpenAI's *_tokens_details.
 *   provider_type               present only when the adapter names itself (Azure:
 *                               'azure'); lets pricing pick the host's own card
 *                               and say "unmapped deployment". Allow-listed.
 *   cache_ttl                   LEGACY single-TTL attribution ('1h' | '5m' | null)
 *                               kept only because `ai_usage_log.cache_ttl` and
 *                               modelCosts.computeCost still price a write at one
 *                               TTL. Derived from the split above; new code must
 *                               read the 5m/1h counts.
 *
 * `normalizeUsage` is idempotent: feeding it an already normalised object (or a
 * mix of provider spellings) returns the same shape, so a consumer that is not
 * sure whether it holds raw or normalised usage can just call it.
 */

const MODALITIES = ['text', 'image', 'audio', 'video', 'document'];

// A usage block is data that came from outside (a provider, or a self-hosted
// endpoint an admin pointed us at), and it ends up in INTEGER columns, cost
// maths and later in a price lookup. So it is read defensively: counts are
// clamped to what an INTEGER column holds (a larger value would fail the whole
// usage INSERT and lose the row), and the free-form facts (tier, geo, traffic
// type, tool names) are only accepted when they look like an identifier.
const MAX_COUNT = 2_000_000_000;
const MAX_TOOL_KEYS = 16;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
const TOOL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
// Which adapter produced the usage, when the adapter says so (today: Azure, whose
// deployment names carry no model). Closed list: a provider cannot name itself
// anything else, and the value only steers which price card is looked up.
const PROVIDER_TYPES = new Set(['claude', 'openai', 'azure', 'google', 'google-vertex', 'mistral', 'scaleway', 'eugpt']);

/** Non-negative integer (at most MAX_COUNT) from anything numeric, else 0. */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_COUNT) : 0;
}

/** First value that is a finite number (0 counts), else undefined. */
function firstNum(...values) {
    for (const v of values) {
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n > 0 ? Math.min(Math.floor(n), MAX_COUNT) : 0;
    }
    return undefined;
}

/** An identifier-shaped string (lower-cased), else null. */
function str(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return IDENT.test(t) ? t.toLowerCase() : null;
}

/** @returns {Record<string, any>} */
function emptyUsage() {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        cache_creation_ttl_assumed: false,
        reasoning_tokens: 0,
        prompt_includes_cache: true,
        service_tier: null,
        inference_geo: null,
        traffic_type: null,
        tool_use: {},
        modality: { prompt: {}, completion: {}, cached: {} },
        cache_ttl: null,
    };
}

/** Legacy dominant-TTL attribution (see the header: only for the old cost path). */
function dominantTtl(fiveMin, oneHour) {
    if (oneHour > 0 && oneHour >= fiveMin) return '1h';
    if (fiveMin > 0) return '5m';
    return null;
}

const GEMINI_KEYS = [
    'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount',
    'cachedContentTokenCount', 'toolUsePromptTokenCount',
    'prompt_token_count', 'candidates_token_count', 'total_token_count',
];

function isGeminiShape(raw) {
    return GEMINI_KEYS.some(k => raw[k] !== undefined);
}

function isAnthropicShape(raw, hint) {
    if (raw.prompt_tokens !== undefined || raw.promptTokens !== undefined) return false;
    if (/claude|anthropic/i.test(hint || '')) return true;
    return raw.cache_read_input_tokens !== undefined
        || raw.cache_creation_input_tokens !== undefined
        || (raw.cache_creation && typeof raw.cache_creation === 'object')
        || (raw.server_tool_use && typeof raw.server_tool_use === 'object');
}

/** Per-modality counts from a Gemini [{modality, tokenCount}] list. */
function geminiModalities(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    for (const entry of list) {
        const key = String(entry?.modality || '').toLowerCase();
        const count = num(entry?.tokenCount ?? entry?.token_count);
        if (MODALITIES.includes(key) && count > 0) out[key] = (out[key] || 0) + count;
    }
    return out;
}

/** Per-modality counts from an OpenAI-shaped details object ({audio_tokens, image_tokens, ...}). */
function detailModalities(details) {
    const out = {};
    if (!details || typeof details !== 'object') return out;
    for (const m of MODALITIES) {
        const count = num(details[`${m}_tokens`] ?? details[`${m}Tokens`]);
        if (count > 0) out[m] = count;
    }
    return out;
}

/** Counts of an already normalised `modality` branch. */
function passModality(branch) {
    const out = {};
    if (!branch || typeof branch !== 'object') return out;
    for (const m of MODALITIES) {
        const count = num(branch[m]);
        if (count > 0) out[m] = count;
    }
    return out;
}

function mergeToolUse(...sources) {
    const out = {};
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        for (const [k, v] of Object.entries(src)) {
            if (!TOOL_KEY.test(k)) continue;
            const n = num(v);
            if (n <= 0) continue;
            if (!Object.hasOwn(out, k) && Object.keys(out).length >= MAX_TOOL_KEYS) continue;
            out[k] = n;
        }
    }
    return out;
}

function pickModality(primary, fallback) {
    return Object.keys(primary).length ? primary : fallback;
}

/**
 * Gemini / Vertex `usageMetadata` (camelCase from the SDK, snake_case from REST).
 * `candidatesTokenCount` is the visible output only: thoughts are billed at the
 * output rate but not counted in it, so they are added to `completion_tokens`.
 * `toolUsePromptTokenCount` (tokens of tool results fed back to the model, e.g.
 * grounding) is billed as input and is added to `prompt_tokens`.
 */
function fromGemini(raw, meta) {
    const g = (camel, snake) => raw[camel] ?? raw[snake];
    const promptBase = num(g('promptTokenCount', 'prompt_token_count'));
    const toolPrompt = num(g('toolUsePromptTokenCount', 'tool_use_prompt_token_count'));
    const candidates = num(g('candidatesTokenCount', 'candidates_token_count'));
    const thoughts = num(g('thoughtsTokenCount', 'thoughts_token_count'));
    const cached = num(g('cachedContentTokenCount', 'cached_content_token_count'));
    const prompt = promptBase + toolPrompt;
    const completion = candidates + thoughts;
    const reported = num(g('totalTokenCount', 'total_token_count'));

    const out = emptyUsage();
    out.prompt_tokens = prompt;
    out.completion_tokens = completion;
    out.total_tokens = reported || prompt + completion;
    out.cached_tokens = cached;
    out.reasoning_tokens = thoughts;
    out.prompt_includes_cache = true;
    out.traffic_type = str(g('trafficType', 'traffic_type'));
    out.tool_use = mergeToolUse(meta?.tool_use, toolPrompt > 0 ? { prompt_tokens: toolPrompt } : null);
    out.modality = {
        prompt: geminiModalities(g('promptTokensDetails', 'prompt_tokens_details')),
        completion: geminiModalities(g('candidatesTokensDetails', 'candidates_tokens_details')),
        cached: geminiModalities(g('cacheTokensDetails', 'cache_tokens_details')),
    };
    return out;
}

/**
 * Everything that is not Gemini: Anthropic (`input_tokens`, `cache_*`), OpenAI
 * Chat Completions (`prompt_tokens`), OpenAI Responses (`input_tokens` with
 * `input_tokens_details`), Mistral (camelCase from the SDK), Scaleway and the
 * local runtimes (OpenAI-shaped), and our own normalised shape.
 */
function fromGeneric(raw, hint, meta) {
    const anthropic = isAnthropicShape(raw, hint);

    const prompt = num(firstNum(raw.input_tokens, raw.prompt_tokens, raw.promptTokens));
    const completion = num(firstNum(raw.output_tokens, raw.completion_tokens, raw.completionTokens));
    const total = num(firstNum(raw.total_tokens, raw.totalTokens)) || prompt + completion;

    const cached = num(firstNum(
        raw.input_tokens_details?.cached_tokens,
        raw.prompt_tokens_details?.cached_tokens,
        raw.promptTokensDetails?.cachedTokens,
        raw.cache_read_input_tokens,
        raw.num_cached_tokens,
        raw.numCachedTokens,
        raw.cached_tokens,
        raw.cachedTokens,
    ));

    const reasoning = num(firstNum(
        raw.output_tokens_details?.reasoning_tokens,
        raw.completion_tokens_details?.reasoning_tokens,
        raw.completionTokensDetails?.reasoningTokens,
        raw.reasoning_tokens,
        raw.reasoningTokens,
    ));

    // Cache writes. Anthropic reports a total plus (on current API versions) a
    // per-TTL breakdown; either may be missing.
    const split5m = num(firstNum(
        raw.cache_creation?.ephemeral_5m_input_tokens, raw.cache_creation_5m_tokens));
    const split1h = num(firstNum(
        raw.cache_creation?.ephemeral_1h_input_tokens, raw.cache_creation_1h_tokens));
    const reportedTotal = num(firstNum(
        raw.cache_creation_input_tokens,
        typeof raw.cache_creation === 'number' ? raw.cache_creation : undefined,
        raw.cache_creation_tokens,
        raw.cacheCreationTokens,
    ));
    const creationTotal = Math.max(reportedTotal, split5m + split1h);
    const remainder = creationTotal - split5m - split1h;
    let five = split5m;
    let one = split1h;
    let assumed = raw.cache_creation_ttl_assumed === true;
    if (remainder > 0) {
        if (anthropic) {
            // Total without a breakdown: extractSystem places a 1h breakpoint.
            one += remainder;
            assumed = true;
        } else {
            // 5m is the default write TTL (claudeModels.cacheWriteMultiplier).
            five += remainder;
        }
    }

    const inclCache = typeof raw.prompt_includes_cache === 'boolean'
        ? raw.prompt_includes_cache
        : !anthropic;

    const promptDetails = raw.input_tokens_details ?? raw.prompt_tokens_details ?? raw.promptTokensDetails;
    const completionDetails = raw.output_tokens_details ?? raw.completion_tokens_details ?? raw.completionTokensDetails;

    const out = emptyUsage();
    out.prompt_tokens = prompt;
    out.completion_tokens = completion;
    out.total_tokens = total;
    out.cached_tokens = cached;
    out.cache_creation_tokens = creationTotal;
    out.cache_creation_5m_tokens = five;
    out.cache_creation_1h_tokens = one;
    out.cache_creation_ttl_assumed = assumed;
    out.reasoning_tokens = reasoning;
    out.prompt_includes_cache = inclCache;
    out.service_tier = str(raw.service_tier ?? raw.serviceTier) ?? str(meta?.service_tier);
    out.inference_geo = str(raw.inference_geo ?? raw.inferenceGeo) ?? str(meta?.inference_geo);
    out.traffic_type = str(raw.traffic_type ?? raw.trafficType) ?? str(meta?.traffic_type);
    out.tool_use = mergeToolUse(raw.server_tool_use, raw.tool_use, meta?.tool_use);
    const providerType = str(raw.provider_type);
    if (providerType && PROVIDER_TYPES.has(providerType)) out.provider_type = providerType;
    out.modality = {
        prompt: pickModality(detailModalities(promptDetails), passModality(raw.modality?.prompt)),
        completion: pickModality(detailModalities(completionDetails), passModality(raw.modality?.completion)),
        cached: passModality(raw.modality?.cached),
    };
    return out;
}

/**
 * @param {string|null|undefined} providerType  adapter/provider type or name
 *   ('claude', 'anthropic', 'openai', 'azure', 'mistral', 'scaleway', 'local',
 *   'google', 'google-vertex', 'eugpt', ...). Only a hint: the shape of `raw`
 *   decides, the hint settles the one ambiguous case (Anthropic's bare
 *   `input_tokens`/`output_tokens` vs the OpenAI Responses API's).
 * @param {object|null|undefined} raw  the provider's usage block
 * @param {{ service_tier?: string, inference_geo?: string, traffic_type?: string,
 *           tool_use?: Record<string, number> }} [meta]  billing facts that live
 *   on the response rather than in the usage block (OpenAI `response.service_tier`,
 *   Gemini grounding search count). Values inside `raw` win.
 * @returns {Record<string, any>|null} the normalised shape, or null when the
 *   provider reported no usage at all (callers keep telling "no usage" from "0").
 */
function normalizeUsage(providerType, raw, meta) {
    if (!raw || typeof raw !== 'object') return null;
    const out = isGeminiShape(raw)
        ? fromGemini(raw, meta)
        : fromGeneric(raw, providerType, meta);
    out.cache_ttl = dominantTtl(out.cache_creation_5m_tokens, out.cache_creation_1h_tokens);
    return out;
}

/**
 * The usage fields of a `usageStore.logUsage` entry, from raw or normalised
 * usage (null -> all zero). Spread it into the entry:
 * `logUsage({ ...ctx, ...usageLogFields(response.usage), stop_reason })`.
 * The store persists the columns it knows (tokens, cache, reasoning, cache_ttl)
 * and ignores the rest until the schema grows to hold them.
 */
function usageLogFields(raw, providerType) {
    return normalizeUsage(providerType, raw) || emptyUsage();
}

/**
 * Sum of several calls (a tool loop is one logical call to its callers but N
 * provider calls underneath). Counts are summed, the 5m/1h split included, so a
 * later phase can price each part; tier/geo/traffic take the last non-null
 * value (a loop runs with one set of request parameters).
 */
function createUsageAccumulator() {
    const total = emptyUsage();
    let seen = false;
    return {
        /** @param {object|null|undefined} usage raw or normalised */
        add(usage, providerType) {
            const u = normalizeUsage(providerType, usage);
            if (!u) return;
            seen = true;
            for (const k of [
                'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens',
                'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens',
                'reasoning_tokens',
            ]) total[k] = Math.min(total[k] + u[k], MAX_COUNT);
            total.cache_creation_ttl_assumed = total.cache_creation_ttl_assumed || u.cache_creation_ttl_assumed;
            total.prompt_includes_cache = u.prompt_includes_cache;
            for (const k of ['service_tier', 'inference_geo', 'traffic_type', 'provider_type']) {
                if (u[k]) total[k] = u[k];
            }
            for (const [k, v] of Object.entries(u.tool_use)) {
                if (!Object.hasOwn(total.tool_use, k) && Object.keys(total.tool_use).length >= MAX_TOOL_KEYS) continue;
                total.tool_use[k] = Math.min((Object.hasOwn(total.tool_use, k) ? total.tool_use[k] : 0) + v, MAX_COUNT);
            }
            for (const branch of ['prompt', 'completion', 'cached']) {
                for (const [m, v] of Object.entries(u.modality[branch])) {
                    const have = Object.hasOwn(total.modality[branch], m) ? total.modality[branch][m] : 0;
                    total.modality[branch][m] = Math.min(have + v, MAX_COUNT);
                }
            }
            total.cache_ttl = dominantTtl(total.cache_creation_5m_tokens, total.cache_creation_1h_tokens);
        },
        /** The running total (same shape as normalizeUsage). */
        total() { return total; },
        /** True once at least one call reported usage. */
        get hasUsage() { return seen; },
    };
}

const TRACKED = Symbol('usageAccumulator');

/**
 * For the builder loops that keep a legacy `{ inputTokens, outputTokens }`
 * totals object (it is spread into SSE events, so it must stay that shape):
 * adds `usage` to the pair AND to a hidden, non-enumerable accumulator on the
 * same object, so the row logged at the end still carries the cache read/write
 * counts, the 5m/1h split and the tier. Returns `totals`.
 */
function trackUsageTotals(totals, usage, providerType) {
    if (!totals || typeof totals !== 'object') return totals;
    const u = normalizeUsage(providerType, usage);
    if (!u) return totals;
    if (!Object.hasOwn(totals, TRACKED)) {
        Object.defineProperty(totals, TRACKED, { value: createUsageAccumulator(), enumerable: false });
    }
    totals[TRACKED].add(u);
    totals.inputTokens = (Number(totals.inputTokens) || 0) + u.prompt_tokens;
    totals.outputTokens = (Number(totals.outputTokens) || 0) + u.completion_tokens;
    return totals;
}

/** `logUsage` fields for a totals object kept with `trackUsageTotals` (or a plain legacy pair). */
function usageTotalsLogFields(totals) {
    const acc = totals && totals[TRACKED];
    if (acc && acc.hasUsage) return { ...acc.total() };
    const prompt = num(totals && totals.inputTokens);
    const completion = num(totals && totals.outputTokens);
    return { ...emptyUsage(), prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = {
    trackUsageTotals,
    usageTotalsLogFields,
    normalizeUsage,
    usageLogFields,
    createUsageAccumulator,
    emptyUsage,
    dominantTtl,
};
