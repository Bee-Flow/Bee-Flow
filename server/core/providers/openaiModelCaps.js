// @typecheck
/**
 * OpenAI / Azure model capability helpers.
 *
 * Single source of truth for the parameter rules, so the OpenAI adapter and the
 * Azure adapter (which extends it) stay in lock-step. The per-model FACTS now
 * live in ./openaiModels.js; this module turns them into request decisions.
 *
 * Why the split matters: these rules used to be regexes ("looks like GPT-5 →
 * has a `minimal` tier", "only codex-max understands `xhigh`"). That held for
 * one generation. gpt-5.6 dropped `minimal` and made `xhigh`/`max` general;
 * gpt-6 additionally dropped `none` and rejects `temperature` outright. A regex
 * cannot express "which values does THIS model accept", and every wrong answer
 * is an HTTP 400 that fails the whole request — so the vocabulary is data and
 * this file only does the clamping.
 *
 * Reference: https://developers.openai.com/api/docs/guides/reasoning and
 * .../guides/latest-model (verified 2026-09-15).
 *   - reasoning.summary accepts `auto` | `detailed`; `concise` is rejected, so
 *     we only ever emit a summary when one was asked for.
 *   - `verbosity` is a GPT-5-only output-length knob (gone in 5.6+).
 *   - `parallel_tool_calls` is not supported when reasoning effort = `minimal`.
 */

const { describeOpenAIModel, CACHE_TTL_OPTIONS } = require('./openaiModels');

/**
 * The effort ladder, weakest to strongest. Used to clamp a requested value into
 * a model's own vocabulary: an unsupported value rounds UP to the next tier the
 * model does offer, and a value above the model's ceiling caps at the ceiling.
 *
 * Rounding up rather than down is deliberate and matches OpenAI's own migration
 * advice for models that dropped the cheap tiers ("if you were using `none` or
 * `minimal`, start with `low`"). Rounding down would mean asking gpt-6 for
 * `minimal` and silently getting nothing at all.
 */
const EFFORT_LADDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Pro variants (gpt-5-pro, gpt-5.2-pro, …) are locked to a single effort. */
function isProModel(model) {
    return typeof model === 'string' && describeOpenAIModel(model).pro;
}

/** Does this model take the GPT-5-only `verbosity` / `text.verbosity` knob? */
function supportsVerbosity(model) {
    return typeof model === 'string' && describeOpenAIModel(model).verbosity;
}

/** Does this model accept a custom `temperature` / `top_p`? */
function supportsTemperature(model) {
    return describeOpenAIModel(model).temperature;
}

/** Is this a reasoning model at all (i.e. does it take a reasoning param)? */
function isReasoningModel(model) {
    return describeOpenAIModel(model).reasoning;
}

/**
 * True when the model accepts tool calls ONLY through the Responses API.
 * gpt-6-astra takes plain text on Chat Completions but rejects tools there, so
 * routing a tool-carrying request to the wrong endpoint fails every agent run.
 */
function requiresResponsesApi(model, options = {}) {
    const caps = describeOpenAIModel(model);
    if (caps.toolsRequireResponses && options.tools && options.tools.length > 0) return true;
    return false;
}

/** Nearest value in `efforts` for a request outside the model's vocabulary. */
function _coerceEffort(efforts, requested) {
    const want = EFFORT_LADDER.indexOf(requested);
    if (want < 0) return null;   // not an effort value at all

    const supported = efforts
        .map(e => EFFORT_LADDER.indexOf(e))
        .filter(i => i >= 0)
        .sort((a, b) => a - b);
    if (!supported.length) return null;

    // Above the model's ceiling → cap. Otherwise round up to the next tier it
    // actually offers.
    const ceiling = supported[supported.length - 1];
    if (want > ceiling) return EFFORT_LADDER[ceiling];
    const up = supported.find(i => i >= want);
    return EFFORT_LADDER[up];
}

/**
 * Clamp a requested reasoning effort to what the given model actually accepts.
 * Returns null when no effort was requested (caller applies its own default) or
 * when the model takes no reasoning parameter at all.
 */
function clampEffort(model, effort) {
    if (!effort) return null;
    const caps = describeOpenAIModel(model);
    if (!caps.efforts || !caps.efforts.length) return null;
    if (caps.efforts.includes(effort)) return effort;
    return _coerceEffort(caps.efforts, effort) || caps.defaultEffort || 'medium';
}

/**
 * Build the Responses API `reasoning` object, or null for a model that takes
 * none — sending `reasoning` to a non-reasoning model is a 400, and since the
 * adapter now defaults to the Responses API for everything, that case is
 * reachable in a way it never used to be.
 *
 * Only attaches `summary` when one was requested (`auto` by default,
 * `detailed` when explicitly asked) — never `concise`, which is rejected.
 */
function buildReasoningParams(model, options = {}) {
    const caps = describeOpenAIModel(model);
    if (!caps.reasoning) return null;

    const reasoning = {};
    reasoning.effort = clampEffort(model, options.reasoningEffort)
        || caps.defaultEffort
        || 'medium';

    if (options.reasoningSummary) {
        reasoning.summary = options.reasoningSummary === 'detailed' ? 'detailed' : 'auto';
    }
    return reasoning;
}

/**
 * Tier-appropriate default verbosity. Returns undefined for models that don't
 * take the parameter so callers can omit it entirely.
 */
function defaultVerbosity(model, tierName) {
    if (!supportsVerbosity(model)) return undefined;
    if (tierName === 'fast' || tierName === 'swarm') return 'low';
    if (tierName === 'writer' || tierName === 'deep_thinking') return 'high';
    return 'medium';
}

/** parallel_tool_calls is incompatible with `minimal` reasoning effort. */
function supportsParallelToolCalls(effort) {
    return effort !== 'minimal';
}

/**
 * Prompt-cache TTL parameters for a model.
 *
 * gpt-5.6+ take `prompt_cache_options: { ttl: '30m' }` — '30m' is the only
 * accepted value and also the default, so sending it is documentation as much
 * as configuration.
 *
 * Earlier models take `prompt_cache_retention` instead, and we deliberately do
 * NOT send it: OpenAI's own default for it moved to '24h' in May 2026, so
 * spelling it out buys nothing, while every parameter we add to a request is
 * one more thing an older model can reject outright. Caching still works on
 * those models — it is automatic and needs no parameter at all.
 *
 * A caller can still force a retention explicitly via `promptCacheRetention`.
 *
 * @returns {object} params to merge into the request body (may be empty)
 */
function cacheTtlParams(model, options = {}) {
    const caps = describeOpenAIModel(model);
    if (caps.cacheTtlParam === CACHE_TTL_OPTIONS) {
        return { prompt_cache_options: { ttl: '30m' } };
    }
    if (options.promptCacheRetention) {
        return { prompt_cache_retention: options.promptCacheRetention };
    }
    return {};
}

/**
 * The two APIs disagree on how a forced function is spelled, and this is NOT a
 * detail that can be papered over with a single pass-through mapper:
 *
 *   Chat Completions:  { type: 'function', function: { name } }
 *   Responses:         { type: 'function', name }
 *
 * Sending the Chat Completions shape to Responses gets
 * `400 Missing required parameter: 'tool_choice.name'` and the whole turn dies.
 * Callers build the Chat Completions shape (see llmClient.forcedToolChoice,
 * which is the shape Claude and Mistral also take), so the Responses path has
 * to translate. Each mapper below normalises BOTH shapes to its own, so a
 * caller can hand either one to either API.
 *
 * Shared rules: 'any'/'required' → 'required'; 'auto'/'none' pass through;
 * the `allowed_tools` restriction object passes through untouched.
 */

/** Extract the forced function name from either spelling. */
function _forcedToolName(toolChoice) {
    return toolChoice?.function?.name || toolChoice?.name || null;
}

function _mapToolChoiceString(toolChoice) {
    if (toolChoice === 'any' || toolChoice === 'required') return 'required';
    if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
    return 'auto';
}

/** `tool_choice` for /v1/chat/completions. */
function mapToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return _mapToolChoiceString(toolChoice);
    if (toolChoice.type && toolChoice.type !== 'function') return toolChoice;
    const name = _forcedToolName(toolChoice);
    if (!name) return toolChoice;
    return { type: 'function', function: { name } };
}

/** `tool_choice` for /v1/responses — flat, no `function` wrapper. */
function mapResponsesToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return _mapToolChoiceString(toolChoice);
    // allowed_tools, mcp, hosted-tool choices and the like pass through as-is.
    if (toolChoice.type && toolChoice.type !== 'function') return toolChoice;
    const name = _forcedToolName(toolChoice);
    if (!name) return toolChoice;
    return { type: 'function', name };
}

/**
 * Can this schema be sent with `strict: true`?
 *
 * Strict mode rides on structured outputs, which imposes two hard rules on
 * EVERY object in the schema: `additionalProperties: false`, and every key in
 * `properties` also listed in `required`. A schema that breaks either one is
 * rejected outright, so setting `strict` blindly would turn working tool calls
 * into 400s — hence a check rather than a flag.
 */
function qualifiesForStrict(schema) {
    if (!schema || typeof schema !== 'object') return false;

    const visit = (node) => {
        if (!node || typeof node !== 'object') return true;

        if (Array.isArray(node)) return node.every(visit);

        const isObjectNode = node.type === 'object'
            || (node.properties && typeof node.properties === 'object');

        if (isObjectNode) {
            if (node.additionalProperties !== false) return false;
            const keys = Object.keys(node.properties || {});
            const required = Array.isArray(node.required) ? node.required : [];
            if (keys.some(k => !required.includes(k))) return false;
            if (!keys.every(k => visit(node.properties[k]))) return false;
        }

        if (node.items && !visit(node.items)) return false;
        for (const key of ['anyOf', 'oneOf', 'allOf']) {
            if (node[key] && !visit(node[key])) return false;
        }
        // $ref can point anywhere; we cannot prove it conforms, so decline.
        if (node.$ref) return false;
        return true;
    };

    return visit(schema);
}

module.exports = {
    EFFORT_LADDER,
    clampEffort,
    buildReasoningParams,
    defaultVerbosity,
    supportsVerbosity,
    supportsTemperature,
    supportsParallelToolCalls,
    isReasoningModel,
    requiresResponsesApi,
    cacheTtlParams,
    mapToolChoice,
    mapResponsesToolChoice,
    qualifiesForStrict,
    isProModel,
};
