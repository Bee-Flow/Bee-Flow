// @typecheck
/**
 * Claude model catalog — capabilities, limits and list prices.
 *
 * Why this file exists: until now every Claude fact lived as a regex, scattered
 * over the adapter (`/^claude-(opus-4-[78]|sonnet-5|…)/` for "rejects
 * temperature"), contextPolicy (1M vs 200k), modelResolver, builderModelProfiles,
 * attachmentProcessor, appStudio/aiRuntime and two frontend copies. That worked
 * while the family was one shape. It stopped working the moment Anthropic
 * shipped generations with a DIFFERENT parameter vocabulary — Opus 4.7 dropped
 * `temperature` and `budget_tokens`, Opus 5 turned thinking ON by default and
 * capped `disabled` at `high` effort, Fable 5.1 refuses forced `tool_choice`
 * outright — because a regex can only say "looks like Opus 4", not "accepts
 * this parameter".
 *
 * It had already cost us two live defects:
 *   - `claude-opus-5` did not match the adapter's adaptive-only regex, so it
 *     was sent `temperature: 1` (and `budget_tokens` when a budget was set).
 *     Opus 5 answers both with a 400.
 *   - The vision regex in core/agentRuntime/attachmentProcessor.js drifted out
 *     of sync with the adapter's and silently omitted Sonnet 5 and Fable 5,
 *     disabling the PDF-vision fallback for models we already ship.
 *
 * So the per-model facts live here as data, in the same spirit as
 * ./openaiModels.js, ./scalewayModels.js and ./localModels.js, and for the same
 * three jobs:
 *
 *  1. CATALOG — id → display name, category, context window, output cap,
 *     capability flags. `/v1/models` hands back bare ids and nothing else.
 *
 *  2. REQUEST SHAPING FACTS — per-model effort vocabulary, whether the model
 *     accepts `temperature` / `budget_tokens` at all, whether forced
 *     `tool_choice` is allowed, and the minimum cacheable prefix. Every one of
 *     these is a 400 (or a silently uncached prompt) when you get it wrong.
 *
 *  3. LIST PRICES — fallback tariffs for modelCosts, so a model the community
 *     pricing database has not picked up yet is billed at its real rate instead
 *     of falling through to the upper-bound guess (which is the most expensive
 *     rate of every model we know, and lands on real PAYG invoices). Before
 *     this file, pricingService's FALLBACK_PRICING had zero Anthropic entries.
 *
 * Dependency-free on purpose: this is required from the adapter, from cost
 * accounting and from route handlers, so it must not pull in anything that
 * could cycle.
 *
 * Catalog verified 2026-09-15 against the Anthropic model and pricing docs.
 * Prices are USD per 1M tokens.
 */

'use strict';

// ─── Effort ladders ──────────────────────────────────────────────────────────
// `xhigh` arrived with Opus 4.7. Opus 4.6 / Sonnet 4.6 stop at `high`/`max`,
// which is why asking them for `xhigh` has to be mapped rather than passed on.
const EFFORT_FULL = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_NO_XHIGH = Object.freeze(['low', 'medium', 'high', 'max']);

// ─── Thinking modes ──────────────────────────────────────────────────────────
// How a model wants extended thinking configured. This is the single fact that
// the old `isAdaptiveOnlyReasoning` regex was trying (and failing) to express.
//
//   'adaptive' — `{type:'adaptive'}` only. Rejects `budget_tokens` AND sampling
//                params (temperature/top_p/top_k) with a 400.
//   'always'   — thinking cannot be turned off at all (Fable/Mythos). Same
//                request surface as 'adaptive' otherwise.
//   'budget'   — legacy 4.x: accepts `{type:'enabled', budget_tokens:N}` and
//                still accepts `temperature`. Adaptive is preferred but not
//                required.
//   'none'     — the product does not drive thinking on this model.
const THINKING_ADAPTIVE = 'adaptive';
const THINKING_ALWAYS = 'always';
const THINKING_BUDGET = 'budget';
const THINKING_NONE = 'none';

// ─── Cache-write premiums ────────────────────────────────────────────────────
// Anthropic charges a premium on cache WRITES, and unlike the read discount it
// depends on the TTL the request asked for. Uniform across the family, so these
// are constants rather than per-entry fields — but they live here so every
// Anthropic tariff is in one file.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;

// Family ranking for "which of these two models is stronger" decisions
// (automation/builderModelProfiles.js). Higher wins.
const FAMILY_RANK = Object.freeze({ fable: 3, mythos: 3, opus: 2, sonnet: 1, haiku: 0 });

/**
 * The catalog.
 *
 * Field notes:
 *   thinking          — see the THINKING_* constants above.
 *   efforts           — null means the model rejects `output_config.effort`.
 *   temperature       — false when the model rejects temperature/top_p/top_k.
 *   forcedToolChoice  — false when `tool_choice: {type:'any'|'tool'}` returns a
 *                       400. The adapter uses forced tool choice to get
 *                       structured output, so this gates that path.
 *   midConvSystem     — accepts `{role:'system'}` entries inside `messages[]`,
 *                       the cache-preserving way to inject an operator
 *                       instruction mid-conversation. Notably NOT Sonnet 5.
 *   cacheMinTokens    — minimum cacheable prefix. Below this a cache_control
 *                       breakpoint is silently ignored. NOT monotonic across
 *                       generations: 512 on the newest, 4096 on Opus 4.6.
 *   price.cachedInput — explicit per-model cached-read rate. Stored rather than
 *                       derived, because the discount is NOT uniform: it is
 *                       0.1x input across most of the family but 0.025x on
 *                       Fable 5.1 / Mythos 5.1.
 */
const CLAUDE_MODELS = {
    // ── Fable / Mythos 5.1 ───────────────────────────────────────────────────
    // Thinking is always on; explicit `{type:'disabled'}` or a budget is a 400.
    // Forced tool choice was REMOVED here — the adapter must fall back to
    // `auto` plus an instruction, or to output_config.format.
    'claude-fable-5-1': {
        name: 'Claude Fable 5.1', cat: 'Reasoning', family: 'fable', generation: 5.1,
        desc: "Anthropic's most capable model — long-horizon agentic work",
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ALWAYS, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: false, midConvSystem: true, contextEditing: true,
        refusalStop: true, cacheMinTokens: 512,
        price: { input: 10.0, cachedInput: 0.25, output: 50.0 },
        released: '2026-08-31',
    },
    'claude-mythos-5-1': {
        name: 'Claude Mythos 5.1', cat: 'Reasoning', family: 'mythos', generation: 5.1,
        desc: 'Project Glasswing counterpart to Fable 5.1',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ALWAYS, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: false, midConvSystem: true, contextEditing: true,
        refusalStop: true, cacheMinTokens: 512,
        price: { input: 10.0, cachedInput: 0.25, output: 50.0 },
    },

    // ── Fable / Mythos 5 ─────────────────────────────────────────────────────
    // Same tier and per-token price as 5.1, but cache reads are 4x dearer and
    // forced tool choice still works.
    'claude-fable-5': {
        name: 'Claude Fable 5', cat: 'Reasoning', family: 'fable', generation: 5,
        desc: 'Previous Fable release — still served',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ALWAYS, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: true, contextEditing: true,
        refusalStop: true, cacheMinTokens: 512,
        price: { input: 10.0, cachedInput: 1.0, output: 50.0 },
    },
    'claude-mythos-5': {
        name: 'Claude Mythos 5', cat: 'Reasoning', family: 'mythos', generation: 5,
        desc: 'Project Glasswing counterpart to Fable 5',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ALWAYS, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: true, contextEditing: true,
        // Mythos 5 runs no safety classifiers, so `refusal` never occurs.
        refusalStop: false, cacheMinTokens: 512,
        price: { input: 10.0, cachedInput: 1.0, output: 50.0 },
    },

    // ── Opus 5 ───────────────────────────────────────────────────────────────
    // Thinking is ON by default here (unlike 4.8/4.7, where omitting `thinking`
    // meant no thinking), and `{type:'disabled'}` is only accepted at effort
    // `high` or below. Cache minimum halves to 512.
    'claude-opus-5': {
        name: 'Claude Opus 5', cat: 'Reasoning', family: 'opus', generation: 5,
        desc: 'Most capable Opus — agentic coding, 1M context',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ADAPTIVE, efforts: EFFORT_FULL, defaultEffort: 'high',
        thinkingOnByDefault: true, disableThinkingMaxEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: true, contextEditing: true,
        refusalStop: true, cacheMinTokens: 512,
        price: { input: 5.0, cachedInput: 0.50, output: 25.0 },
        released: '2026-07-24',
    },

    // ── Opus 4.8 / 4.7 ───────────────────────────────────────────────────────
    'claude-opus-4-8': {
        name: 'Claude Opus 4.8', cat: 'Reasoning', family: 'opus', generation: 4.8,
        desc: 'Adaptive thinking, agentic coding, 1M context',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ADAPTIVE, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: true, contextEditing: true,
        cacheMinTokens: 1024,
        price: { input: 5.0, cachedInput: 0.50, output: 25.0 },
    },
    'claude-opus-4-7': {
        name: 'Claude Opus 4.7', cat: 'Reasoning', family: 'opus', generation: 4.7,
        desc: 'Adaptive thinking, agentic coding, 1M context',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ADAPTIVE, efforts: EFFORT_FULL, defaultEffort: 'high',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: false, contextEditing: true,
        cacheMinTokens: 2048,
        price: { input: 5.0, cachedInput: 0.50, output: 25.0 },
    },

    // ── Opus 4.6 ─────────────────────────────────────────────────────────────
    // The last Opus that still accepts `temperature` and `budget_tokens`, and
    // the last without `xhigh`. Cache minimum is 4096 — eight times Opus 5's.
    'claude-opus-4-6': {
        name: 'Claude Opus 4.6', cat: 'Reasoning', family: 'opus', generation: 4.6,
        desc: 'Powerful reasoning with adaptive thinking',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_BUDGET, efforts: EFFORT_NO_XHIGH, defaultEffort: 'medium',
        temperature: true, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: false, contextEditing: true,
        cacheMinTokens: 4096,
        price: { input: 5.0, cachedInput: 0.50, output: 25.0 },
    },

    // ── Sonnet 5 / 4.6 ───────────────────────────────────────────────────────
    // Sonnet 5 is adaptive-only but does NOT take mid-conversation system
    // messages — the one place where it diverges from the Opus 5 surface.
    'claude-sonnet-5': {
        name: 'Claude Sonnet 5', cat: 'Generalist', family: 'sonnet', generation: 5,
        desc: 'Balanced speed and intelligence, 1M context',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_ADAPTIVE, efforts: EFFORT_FULL, defaultEffort: 'medium',
        temperature: false, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: false, contextEditing: true,
        cacheMinTokens: 1024,
        price: { input: 2.0, cachedInput: 0.20, output: 10.0 },
    },
    'claude-sonnet-4-6': {
        name: 'Claude Sonnet 4.6', cat: 'Generalist', family: 'sonnet', generation: 4.6,
        desc: 'Balanced speed and intelligence, 1M context',
        context: 1_000_000, maxOutput: 128_000,
        thinking: THINKING_BUDGET, efforts: EFFORT_NO_XHIGH, defaultEffort: 'medium',
        temperature: true, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: false, contextEditing: true,
        cacheMinTokens: 1024,
        price: { input: 3.0, cachedInput: 0.30, output: 15.0 },
    },

    // ── Haiku 4.5 ────────────────────────────────────────────────────────────
    // NOTE: Anthropic does support extended thinking on Haiku 4.5 via
    // `budget_tokens`, but NOT adaptive thinking and NOT `effort`. This product
    // has always treated it as a non-reasoning model (the adapter's
    // supportsReasoning returned false for it), and that behaviour is preserved
    // here deliberately rather than changed as a side effect of the refactor.
    'claude-haiku-4-5': {
        name: 'Claude Haiku 4.5', cat: 'Generalist', family: 'haiku', generation: 4.5,
        desc: 'Fastest Claude with near-frontier intelligence',
        context: 200_000, maxOutput: 64_000,
        thinking: THINKING_NONE, efforts: null, defaultEffort: null,
        temperature: true, vision: true, tools: true,
        forcedToolChoice: true, midConvSystem: false, contextEditing: true,
        cacheMinTokens: 4096,
        price: { input: 1.0, cachedInput: 0.10, output: 5.0 },
    },
};

/** Aliases Anthropic publishes alongside the concrete ids. */
const MODEL_ALIASES = Object.freeze({
    'claude-fable': 'claude-fable-5-1',
    'claude-mythos': 'claude-mythos-5-1',
    'claude-opus': 'claude-opus-5',
    'claude-sonnet': 'claude-sonnet-5',
    'claude-haiku': 'claude-haiku-4-5',
});

/**
 * Canonicalise a model id.
 *
 * Handles the four shapes the same model arrives in across our providers:
 *   claude-opus-5                  — Claude API
 *   anthropic.claude-opus-5        — Amazon Bedrock
 *   anthropic/claude-opus-5        — OpenRouter-style routing prefix
 *   claude-opus-4-5@20251101       — Vertex AI dated snapshot
 *   claude-haiku-4-5-20251001      — Claude API dated snapshot
 */
function normalizeClaudeModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    let id = modelId.trim().toLowerCase();

    // Routing prefixes: `anthropic/…` or a bare vendor path.
    const slash = id.lastIndexOf('/');
    if (slash >= 0) id = id.slice(slash + 1);
    // Bedrock's dotted vendor prefix.
    if (id.startsWith('anthropic.')) id = id.slice('anthropic.'.length);
    // Vertex pins the snapshot with `@`, not `-`.
    const at = id.indexOf('@');
    if (at > 0) id = id.slice(0, at);

    if (MODEL_ALIASES[id]) return MODEL_ALIASES[id];
    if (CLAUDE_MODELS[id]) return id;

    // Dated snapshot pin, e.g. claude-haiku-4-5-20251001. Eight digits, so this
    // can never eat a version segment like the `-8` of claude-opus-4-8.
    const undated = id.replace(/-\d{8}$/, '');
    if (CLAUDE_MODELS[undated]) return undated;
    if (MODEL_ALIASES[undated]) return MODEL_ALIASES[undated];
    return undated || id;
}

/** Raw catalog entry for an id, or null when it is not a model we know. */
function getClaudeModel(modelId) {
    return CLAUDE_MODELS[normalizeClaudeModelId(modelId)] || null;
}

/** Is this id an Anthropic model at all? */
function isClaudeModelId(modelId) {
    const id = normalizeClaudeModelId(modelId);
    return !!id && /^claude-/.test(id);
}

/**
 * Parse `claude-<family>-<major>[-<minor>]` into comparable parts.
 *
 * Note Anthropic's two id schemes: modern ids are family-first
 * (`claude-opus-4-8`), legacy 3.x ids are number-first
 * (`claude-3-5-sonnet-20241022`). Both are handled, because a customer config
 * can still carry the old one.
 *
 * @returns {{family:string, generation:number}|null}
 */
function _parseClaudeVersion(id) {
    // Modern: claude-opus-4-8, claude-sonnet-5, claude-fable-5-1
    let m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(id);
    if (m) {
        const minor = m[3] ? Number(m[3]) : 0;
        return { family: m[1], generation: Number(`${m[2]}.${minor}`) };
    }
    // Legacy number-first: claude-3-5-sonnet-…, claude-3-opus-…
    m = /^claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)/.exec(id);
    if (m) {
        const minor = m[2] ? Number(m[2]) : 0;
        return { family: m[3], generation: Number(`${m[1]}.${minor}`) };
    }
    return null;
}

/**
 * Profile for an id the catalog has never heard of.
 *
 * This is what makes the fallback future-proof: claude-opus-6 and
 * claude-sonnet-5-5 do not exist yet, but they will, and they should follow
 * their generation's rules rather than whatever regex happened to be written
 * today. An `undefined` here is exactly the failure that made claude-opus-5
 * send `temperature: 1` to a model that 400s on it.
 *
 * The bias is deliberately toward the NEWER surface: a wrongly-omitted
 * `temperature` costs nothing, while a wrongly-sent one is a hard 400.
 */
function _guessProfile(id) {
    const v = _parseClaudeVersion(id);
    if (!v) {
        // Not parseable as a Claude id at all. Assume the modern surface and a
        // conservative window; never guess a price.
        return {
            name: id, cat: 'Generalist', family: 'other', generation: 0,
            context: 200_000, maxOutput: 8192,
            thinking: THINKING_ADAPTIVE, efforts: EFFORT_FULL, defaultEffort: 'medium',
            temperature: false, vision: false, tools: true,
            forcedToolChoice: true, midConvSystem: false, contextEditing: false,
            cacheMinTokens: 4096,
        };
    }

    const { family, generation } = v;
    const modern = generation >= 4.7;   // temperature + budget_tokens removed
    const gen5 = generation >= 5;

    // Fable/Mythos are an always-thinking family regardless of generation.
    const fableLike = family === 'fable' || family === 'mythos';
    // Haiku: this product does not drive thinking on it (see catalog note).
    const haiku = family === 'haiku';

    // Claude 3.x has no extended thinking as this product drives it, and sending
    // a `thinking` param to one is an error — the adapter's old supportsReasoning
    // regex (`^claude-(opus|sonnet)-[45]`) never matched a 3.x id, and that
    // behaviour is preserved rather than changed by the catalog.
    const legacy3x = generation < 4;

    let thinking = THINKING_BUDGET;
    if (fableLike) thinking = THINKING_ALWAYS;
    else if (haiku || legacy3x) thinking = THINKING_NONE;
    else if (modern) thinking = THINKING_ADAPTIVE;

    return {
        name: id,
        cat: (fableLike || family === 'opus') ? 'Reasoning' : 'Generalist',
        family, generation,
        context: (fableLike || gen5 || generation >= 4.6) && !haiku ? 1_000_000 : 200_000,
        maxOutput: haiku ? 64_000 : 128_000,
        thinking,
        efforts: (haiku || legacy3x) ? null : (modern || fableLike ? EFFORT_FULL : EFFORT_NO_XHIGH),
        defaultEffort: (haiku || legacy3x) ? null : 'medium',
        // Only 4.6 and older accept sampling params — and only in the
        // opus/sonnet line. Haiku still accepts them.
        temperature: (haiku || legacy3x) ? true : !(modern || fableLike),
        vision: true,
        tools: true,
        // Forced tool choice was removed from Fable 5.1 on, and from Opus 5.5
        // and Sonnet 5.5 on (`tool_choice: type "tool" and "any" are not
        // supported for this model.`). Assume every later generation keeps it
        // removed: a wrongly-unforced call still answers through the adapter's
        // `auto` fallback, a wrongly-forced one is a hard 400.
        forcedToolChoice: !((fableLike && generation >= 5.1) || generation >= 5.5),
        midConvSystem: fableLike || (family === 'opus' && generation >= 4.8),
        contextEditing: generation >= 4,
        refusalStop: fableLike || gen5,
        cacheMinTokens: gen5 || fableLike ? 512 : (generation >= 4.8 ? 1024 : 4096),
        // No price: a guessed tariff on a real invoice is worse than no tariff.
    };
}

/**
 * Everything the rest of the codebase needs to know about a Claude model.
 * Always returns a full object — never undefined fields — so callers can read
 * a property without a guard.
 *
 * `known` says whether the answer came from the catalog or from the generation
 * fallback, so callers that want to be cautious (pricing, for one) can tell.
 */
function describeClaudeModel(modelId) {
    const id = normalizeClaudeModelId(modelId);
    const entry = CLAUDE_MODELS[id];
    const base = entry || _guessProfile(id);

    const thinking = base.thinking || THINKING_NONE;
    return {
        id,
        known: !!entry,
        name: base.name || id,
        cat: base.cat || 'Generalist',
        desc: base.desc || '',
        family: base.family || 'other',
        generation: base.generation ?? 0,
        rank: FAMILY_RANK[base.family] ?? -1,
        context: base.context ?? null,
        maxOutput: base.maxOutput ?? null,
        thinking,
        // Does the model do extended thinking at all, as this product drives it?
        reasoning: thinking !== THINKING_NONE,
        // Rejects budget_tokens AND sampling params. This is the fact the old
        // isAdaptiveOnlyReasoning regex expressed — and got wrong for Opus 5.
        adaptiveOnly: thinking === THINKING_ADAPTIVE || thinking === THINKING_ALWAYS,
        thinkingOnByDefault: !!base.thinkingOnByDefault,
        disableThinkingMaxEffort: base.disableThinkingMaxEffort || null,
        efforts: base.efforts || null,
        defaultEffort: base.defaultEffort || null,
        temperature: base.temperature !== false,
        vision: !!base.vision,
        // Native PDF document blocks ride the same capability: anything that
        // can see an image can take a document block.
        documents: !!base.vision,
        tools: base.tools !== false,
        forcedToolChoice: base.forcedToolChoice !== false,
        midConvSystem: !!base.midConvSystem,
        contextEditing: !!base.contextEditing,
        refusalStop: !!base.refusalStop,
        cacheMinTokens: base.cacheMinTokens ?? 4096,
        price: base.price || null,
        released: base.released || null,
        deprecated: base.deprecated || null,
    };
}

/**
 * Coerce a requested effort to one this model actually accepts.
 *
 * Replaces the adapter's EFFORT_MAP_XHIGH / EFFORT_MAP_LEGACY pair. The legacy
 * mapping of `xhigh` → `max` is preserved: on a ladder without `xhigh`, asking
 * for more than `high` should mean `max`, not silently drop to the default.
 */
function resolveEffort(modelId, requested) {
    const { efforts, defaultEffort } = describeClaudeModel(modelId);
    if (!efforts) return null;
    const want = String(requested || '').toLowerCase();
    if (efforts.includes(want)) return want;
    // `minimal` is an OpenAI word that reaches us through shared tier config.
    if (want === 'minimal') return 'low';
    if (want === 'xhigh') return efforts.includes('max') ? 'max' : 'high';
    return defaultEffort || 'medium';
}

/** Does this model accept `effort` as a reasoning-effort value? */
function supportsEffort(modelId, effort) {
    const { efforts } = describeClaudeModel(modelId);
    return !!efforts && efforts.includes(effort);
}

/** Context window (max input tokens) for a Claude id. */
function contextWindowFor(modelId) {
    return describeClaudeModel(modelId).context;
}

/**
 * List price for a model, or null when we only guessed at the model.
 * Never invents a tariff — an invented number on an invoice is worse than a
 * known-missing one.
 */
function getClaudeListPrice(modelId) {
    const entry = getClaudeModel(modelId);
    return entry && entry.price ? entry.price : null;
}

/**
 * Fallback tariffs in the exact shape pricingService.FALLBACK_PRICING expects.
 * Before this existed, that map was OpenAI-only, so any Claude model the
 * community pricing database had not picked up yet fell through to the
 * upper-bound rates.
 */
function listPricedModels() {
    const out = {};
    for (const [id, entry] of Object.entries(CLAUDE_MODELS)) {
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
 * Cache-write multiplier for a TTL. Anthropic bills writes above the input
 * rate; the premium depends on the TTL the request asked for.
 */
function cacheWriteMultiplier(ttl) {
    return ttl === '1h' ? CACHE_WRITE_1H : CACHE_WRITE_5M;
}

/** Cache-read discount as a fraction of the input rate. */
function cacheReadDiscount(modelId) {
    const price = getClaudeListPrice(modelId);
    if (price && price.input > 0 && Number.isFinite(price.cachedInput)) {
        return price.cachedInput / price.input;
    }
    return 0.1; // the family-wide default
}

/** Catalog ids, for admin pickers and the /api model list. */
function listCatalogModels() {
    return Object.entries(CLAUDE_MODELS).map(([id, e]) => ({
        id,
        name: e.name,
        cat: e.cat,
        desc: e.desc || '',
        context: e.context,
        maxOutput: e.maxOutput,
        reasoning: e.thinking !== THINKING_NONE,
        vision: !!e.vision,
        input: e.price ? e.price.input : null,
        output: e.price ? e.price.output : null,
        deprecated: e.deprecated || null,
    }));
}

/** Deprecation record for an id, or null. */
function getDeprecation(modelId) {
    const entry = getClaudeModel(modelId);
    return (entry && entry.deprecated) || null;
}

module.exports = {
    CLAUDE_MODELS,
    MODEL_ALIASES,
    EFFORT_FULL,
    EFFORT_NO_XHIGH,
    THINKING_ADAPTIVE,
    THINKING_ALWAYS,
    THINKING_BUDGET,
    THINKING_NONE,
    CACHE_WRITE_5M,
    CACHE_WRITE_1H,
    FAMILY_RANK,
    normalizeClaudeModelId,
    getClaudeModel,
    isClaudeModelId,
    describeClaudeModel,
    resolveEffort,
    supportsEffort,
    contextWindowFor,
    getClaudeListPrice,
    listPricedModels,
    cacheWriteMultiplier,
    cacheReadDiscount,
    listCatalogModels,
    getDeprecation,
};
