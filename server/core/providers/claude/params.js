// @typecheck
/**
 * Claude adapter: building the SDK request params.
 *
 * Thinking config (adaptive / budget, effort, display), message
 * normalisation call, tool choice (forced and its `auto` fallback),
 * server-side context management and structured output. The functions
 * take the provider instance so subclass / instance overrides of its
 * capability methods keep applying. Split out of core/providers/claude.js,
 * whose methods delegate here.
 */

const { describeClaudeModel, resolveEffort } = require("../claudeModels");

const DEFAULT_MAX_TOKENS = 8192;

// Server-side context editing (Claude-only): Anthropic clears old tool
// results from the prompt before the model sees it, once a request crosses
// the trigger. Applied entirely on Anthropic's side — our own history and
// persistence are untouched, so it composes with the provider-agnostic
// watermark compaction in core/compaction.js (that handles cross-turn
// history; this handles heavy in-turn tool loops). Escape hatch:
// CLAUDE_CONTEXT_EDITING_DISABLED=1 turns it off without a code change.
const CONTEXT_EDITING_BETA = 'context-management-2025-06-27';
const CONTEXT_EDITING_DISABLED = process.env.CLAUDE_CONTEXT_EDITING_DISABLED === '1';

/**
 * Whether the API returns the reasoning TEXT alongside each thinking block.
 *
 * This is not cosmetic and it is not the same switch as "is thinking on".
 * `display` defaults to `'omitted'` on Claude Opus 5, Sonnet 5, Opus 4.8/4.7
 * and Fable/Mythos 5 — a silent change from Opus 4.6 / Sonnet 4.6, where the
 * default was `'summarized'`. With `'omitted'` the model still thinks, is still
 * billed for it, and still returns a signed thinking block — but the `thinking`
 * field is an empty string and NO `thinking_delta` events are streamed. The
 * product's reasoning panel then has nothing to render and hides itself, which
 * looks exactly like "thinking is broken".
 *
 * So the default here is `'summarized'`: this app shows reasoning to the user.
 * `'omitted'` is the right choice for a deployment that never surfaces it —
 * it trims time-to-first-text-token — but it saves no money.
 *
 * CLAUDE_THINKING_DISPLAY=summarized | omitted
 */
const THINKING_DISPLAY = (() => {
    const raw = String(process.env.CLAUDE_THINKING_DISPLAY || '').trim().toLowerCase();
    return raw === 'omitted' ? 'omitted' : 'summarized';
})();

/**
 * How many assistant turns of thinking the API is asked to preserve.
 *
 * 'all' (default) keeps the model's whole reasoning trail in context, which is
 * the point — on Opus 4.6 / Sonnet 4.6 and earlier the API otherwise keeps
 * only the LAST turn. 'off' omits the edit entirely (falls back to the model
 * default); a positive integer caps it for deployments that would rather pay
 * less than let the model re-read every earlier thought.
 *
 * CLAUDE_KEEP_THINKING_TURNS=all | off | <positive integer>
 */
const KEEP_THINKING_TURNS = (() => {
    const raw = String(process.env.CLAUDE_KEEP_THINKING_TURNS || '').trim().toLowerCase();
    if (raw === 'off' || raw === '0') return 'off';
    if (raw === 'all' || raw === '') return 'all';
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : 'all';
})();

/**
 * The instruction that stands in for a forced `tool_choice` on the models that
 * refuse one (see supportsForcedToolChoice). `auto` does not guarantee a call,
 * so the prompt has to say that the tool IS the answer — the documented
 * replacement for `{type:'tool'}` / `{type:'any'}`.
 */
function forcedToolInstruction(toolName) {
    return toolName
        ? `Respond by calling the \`${toolName}\` tool exactly once, with arguments that follow its input schema. Do not answer in plain text.`
        : 'Respond by calling one of the provided tools, with arguments that follow its input schema. Do not answer in plain text.';
}

// Claude structured outputs reject numeric and length constraints
// ("For 'number' type, properties maximum, minimum are not supported"), so they
// are dropped from the schema we send. Callers validate ranges themselves.
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength']);
function stripUnsupportedSchemaKeywords(node) {
    if (Array.isArray(node)) return node.map(stripUnsupportedSchemaKeywords);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (UNSUPPORTED_SCHEMA_KEYWORDS.has(k) && (typeof v === 'number')) continue;
        out[k] = stripUnsupportedSchemaKeywords(v);
    }
    return out;
}

/** @param {any} provider @param {string} model @param {any} [options] */
function buildThinking(provider, model, options = {}) {
    if (!provider.supportsReasoning(model)) return undefined;

    const effortRaw = options.reasoningEffort;
    if (effortRaw === 'none') return undefined; // Explicitly disabled

    // Adaptive-only models reject manual budget_tokens. Legacy 4.x (Opus 4.6 /
    // Sonnet 4.6) still accept it, though adaptive is recommended.
    const adaptiveOnly = provider.isAdaptiveOnlyReasoning(model);
    if (!adaptiveOnly && options.budgetTokens && options.budgetTokens > 0) {
        return { thinking: { type: "enabled", budget_tokens: options.budgetTokens } };
    }

    // Adaptive thinking: effort is passed via output_config (top-level), not
    // nested in thinking. Which levels a model actually accepts is a
    // per-model fact (`xhigh` only arrived with Opus 4.7), so the ladder and
    // the xhigh->max fallback for the ladders without it live in the catalog.
    const effort = resolveEffort(model, effortRaw) || 'medium';
    // `display` is what makes the reasoning visible at all — see
    // THINKING_DISPLAY. The legacy `budget_tokens` path above deliberately
    // leaves it unset: those models already default to 'summarized', so
    // the only thing setting it there could do is break on an older API.
    return { thinking: { type: "adaptive", display: THINKING_DISPLAY }, effort };
}

/** @param {any} provider @param {string} model @param {any[]} messages @param {any} [options] */
function buildSdkParams(provider, model, messages, options = {}) {
    // Resolved first: whether thinking is on decides whether stored
    // thinking blocks are worth replaying into the history at all.
    let thinkingConfig = provider.buildThinking(model, options);

    // Extended thinking is incompatible with a forced tool choice: per
    // https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
    // only `auto` and `none` are allowed while thinking is enabled —
    // `any`/`tool` get a 400 and the whole call fails. Forced choice is the
    // mechanical structured-output path (llmClient.chatForcedTool), where
    // reasoning adds nothing, so thinking yields to the force, never the
    // other way around. Skipping replay too: thinking blocks without a
    // thinking param are dead weight in the history.
    //
    // Sonnet 5.5, Opus 5.5 and Fable/Mythos 5.1 refuse a forced choice
    // outright (400 `tool_choice: type "tool" and "any" are not supported
    // for this model.`). There the call runs with `auto` plus an explicit
    // instruction naming the tool (forcedToolFallback), and thinking STAYS
    // on: it cannot be switched off on those models anyway, and dropping
    // the config would only lose the effort and the max_tokens headroom.
    const tc = options.toolChoice;
    const forcedName = tc && typeof tc === 'object' ? (tc.name || tc.function?.name || null) : null;
    const forcedChoice = tc === 'any' || tc === 'required' || !!forcedName;
    const unforced = forcedChoice && (options._noForcedToolChoice || !provider.supportsForcedToolChoice(model));
    if (forcedChoice && !unforced && thinkingConfig) {
        thinkingConfig = undefined;
    }
    const keepThinking = !!thinkingConfig && !options._noThinkingReplay;

    const params = {
        model,
        messages: provider.normalizeMessages(messages, { keepThinking }),
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    const system = provider.extractSystem(messages);
    if (system) params.system = system;

    // The adaptive-only family (Opus 4.7/4.8, Sonnet 5, Fable/Mythos 5) rejects
    // sampling params with a 400 — never forward a caller-supplied temperature.
    const adaptiveOnly = provider.isAdaptiveOnlyReasoning(model);
    if (options.temperature !== undefined && !adaptiveOnly && describeClaudeModel(model).temperature) params.temperature = options.temperature;

    if (options.tools && options.tools.length > 0) {
        const normalizedTools = provider.normalizeTools(options.tools);
        // Tools come before system in Anthropic's wire format. Per the
        // mixed-TTL rule ("longer TTL must appear first"), placing a
        // 5-min breakpoint on tools while system has a 1-hour breakpoint
        // would violate ordering. The system block-1 1h breakpoint
        // already caches "tools + system" as a single prefix, so the
        // standalone tools breakpoint is redundant — drop it.
        params.tools = normalizedTools;
        if (options.toolChoice === "auto") params.tool_choice = { type: "auto" };
        if (unforced) {
            params.tool_choice = { type: "auto" };
            params.system = [...(params.system || []), { type: "text", text: forcedToolInstruction(forcedName) }];
        } else if (options.toolChoice === "any" || options.toolChoice === "required") {
            params.tool_choice = { type: "any" };
        } else if (forcedName) {
            // Force a single named tool. Accept BOTH the bare `{name}` form
            // and the OpenAI wire shape `{type:'function',function:{name}}`
            // that openai-style callers and llmClient.forcedToolChoice emit —
            // Anthropic's SDK only understands `{type:'tool',name}`, so a
            // caller passing the OpenAI shape would fall through here and
            // silently run with tool_choice unset (auto), breaking every
            // forced-structured-output call routed to a Claude model.
            params.tool_choice = { type: "tool", name: forcedName };
        }
    }

    // ─── Server-side context management ──────────────────────────
    //
    // This is the LOSSLESS half of context handling and, since local
    // compaction became opt-in (core/llm/contextPolicy.js), the one that
    // normally runs. Anthropic edits the request server-side; our stored
    // conversation is never rewritten, so nothing is destroyed for later
    // turns the way a fast-tier summary destroys it.
    //
    // Two edits, and ORDER MATTERS — `clear_thinking_20251015` must come
    // first when combined, per Anthropic's docs.
    //
    //   1. clear_thinking_20251015 — `keep: all`. Not a no-op: on Opus 4.6
    //      / Sonnet 4.6 and earlier the API's DEFAULT is to keep only the
    //      last turn's thinking and silently drop the rest, which is half
    //      of "the model loses its reasoning in long chats". We replay the
    //      blocks (replayThinkingBlocks) and this stops the server from
    //      throwing them away again. Opus 4.5+/Sonnet 4.6+ already default
    //      to keeping everything, so there it just pins the behaviour.
    //      CLAUDE_KEEP_THINKING_TURNS=<n> caps it for cost-sensitive
    //      deployments.
    //
    //   2. clear_tool_uses_20250919 — only meaningful with tools in play.
    //      Fires on genuinely heavy tool turns, keeps the recent pairs the
    //      model is actively reasoning about, and clears enough per
    //      activation to justify the cache invalidation at the clear point.
    //      `clear_tool_inputs` stays false so the model still sees WHAT it
    //      called even once the result is gone.
    //
    // Native server-side compaction (compact_20260112) is deliberately NOT
    // enabled: its compaction blocks must be replayed verbatim on later
    // requests, and our flattened message persistence cannot round-trip
    // them.
    if (!CONTEXT_EDITING_DISABLED && !options._noContextEditing && provider.supportsContextEditing(model)) {
        const edits = [];

        if (thinkingConfig && KEEP_THINKING_TURNS !== 'off') {
            edits.push({
                type: 'clear_thinking_20251015',
                keep: KEEP_THINKING_TURNS === 'all'
                    ? { type: 'all' }
                    : { type: 'thinking_turns', value: KEEP_THINKING_TURNS },
            });
        }

        if (params.tools) {
            edits.push({
                type: 'clear_tool_uses_20250919',
                trigger: { type: 'input_tokens', value: 30000 },
                keep: { type: 'tool_uses', value: 5 },
                clear_at_least: { type: 'input_tokens', value: 5000 },
            });
        }

        if (edits.length > 0) params.context_management = { edits };
    }

    if (thinkingConfig) {
        params.thinking = thinkingConfig.thinking;
        // Legacy 4.x require temperature=1 when thinking is enabled; the
        // adaptive-only family rejects sampling params, so leave it unset.
        if (!adaptiveOnly) params.temperature = 1;
        if (thinkingConfig.thinking.type === 'adaptive') {
            // effort belongs inside output_config per SDK v0.78.0 OutputConfig interface
            if (thinkingConfig.effort) {
                params.output_config = { effort: thinkingConfig.effort };
            }
            // Ensure enough room for thinking + answer
            if (params.max_tokens < 16384) params.max_tokens = 16384;
        } else if (thinkingConfig.thinking.budget_tokens && params.max_tokens < thinkingConfig.thinking.budget_tokens + 1024) {
            // Legacy budget_tokens mode
            params.max_tokens = thinkingConfig.thinking.budget_tokens + 1024;
        }
    }

    if (options.responseFormat?.type === 'json_schema' && options.responseFormat.json_schema?.schema) {
        params.output_config = { ...params.output_config,
            format: { type: 'json_schema', schema: stripUnsupportedSchemaKeywords(options.responseFormat.json_schema.schema) } };
    }
    return params;
}

/**
 * Per-request headers for beta params attached by _buildSdkParams.
 * Per-request headers REPLACE defaultHeaders with the same name, so in
 * OAuth mode the oauth beta must ride along with the context-management
 * beta (comma-separated list is the documented form).
 * @param {boolean} oauth
 */
function requestOptionsFor(params, oauth) {
    if (!params.context_management) return undefined;
    const betas = oauth ? `oauth-2025-04-20,${CONTEXT_EDITING_BETA}` : CONTEXT_EDITING_BETA;
    return { headers: { 'anthropic-beta': betas } };
}

module.exports = {
    DEFAULT_MAX_TOKENS,
    CONTEXT_EDITING_BETA,
    CONTEXT_EDITING_DISABLED,
    THINKING_DISPLAY,
    KEEP_THINKING_TURNS,
    forcedToolInstruction,
    stripUnsupportedSchemaKeywords,
    buildThinking,
    buildSdkParams,
    requestOptionsFor,
};

/**
 * `context_management` is a beta param the SDK's types do not carry yet.
 * @typedef {import('@anthropic-ai/sdk/resources/messages.js').MessageCreateParamsNonStreaming & { context_management?: { edits: Array<Record<string, unknown>> } }} SdkParams
 */
