// @typecheck
/**
 * Claude/Anthropic Provider Adapter
 *
 * 100% SDK-based — uses @anthropic-ai/sdk for ALL API calls.
 * No raw fetch, no base URL needed. The SDK handles endpoints internally.
 */

const BaseProvider = require("./base");
const { qualifiesForStrict } = require("./openaiModelCaps");
const { describeClaudeModel } = require("./claudeModels");
const { downscaleClaudeMessages } = require("../documents/imageDownscale");
const { inlineInternalImages } = require("../documents/imageInline");
const log = require('../../telemetry/log');
const { normalizeUsage } = require("./usageNormalizer");
const { mergeToolResultRuns, repairToolPairs } = require("./claude/messageRepair");
const { applyPromptCacheBreakpoints } = require("./claude/promptCache");
const {
    refusalMessage,
    isContextWindowStop,
    isThinkingReplayRejection,
    isForcedToolChoiceRejection,
    isContextManagementRejection,
} = require("./claude/errors");
const { buildThinking, buildSdkParams, requestOptionsFor } = require("./claude/params");
const { fallback } = require('../../utils/bestEffort');

// Explicit SDK request timeout. Passing ANY constructor `timeout` disables the
// SDK's pre-flight "Streaming is required for operations that may take longer
// than 10 minutes" guard (see @anthropic-ai/sdk messages.create: the guard only
// runs when the client was built with `timeout == null`). Without this, a
// non-streaming chat() with a reasoning model throws synchronously whenever
// max_tokens clears the guard's ceiling — either the time-based limit
// (max_tokens > ~21333) or a per-model cap (Opus 4/4.1 non-streaming = 8192,
// which adaptive thinking's 16384 max_tokens bump always exceeds). That broke
// the Support auto-responder ("AI auto-responder failed (Streaming is
// required…). Escalated to staff."). 600000ms matches the SDK's own default, so
// the effective request timeout is unchanged — only the over-conservative
// estimate-based pre-flight rejection is removed. Streaming is exempt from the
// guard and already used its default 10-min timeout, so it is unaffected.
const SDK_TIMEOUT_MS = 600000; // 10 minutes (== @anthropic-ai/sdk DEFAULT_TIMEOUT)

// Claude Code subscription (OAuth) tokens are only accepted by the Anthropic API
// when the first system block is exactly this string. Injected in OAuth dev mode
// (BEEFLOW_CLAUDE_CODE_OAUTH=1); see core/providers/claudeCodeAuth.js.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

class ClaudeProvider extends BaseProvider {
    // Modern Claude models can reject forced tool_choice. Use native JSON for
    // closed structured-output schemas; actual action tools keep their own path.
    /**
     * @param {string} modelId
     */
    supportsStructuredOutput(modelId, schema) {
        const match = describeClaudeModel(modelId).id.match(/^claude-(?:sonnet|opus|haiku|fable|mythos)-(\d+)/);
        return !!match && Number(match[1]) >= 5 && (schema === undefined || qualifiesForStrict(schema));
    }

    /**
     * Whether `tool_choice: {type:'tool'|'any'}` is accepted. False on Sonnet
     * 5.5, Opus 5.5 and Fable/Mythos 5.1 onwards; _buildSdkParams then sends
     * `auto` plus forcedToolInstruction, and llmClient.chatForcedTool retries
     * once when the model still answered in prose.
     * @param {string} modelId
     */
    supportsForcedToolChoice(modelId) {
        return describeClaudeModel(modelId).forcedToolChoice;
    }

    constructor() {
        super("claude");
    }

    // ─── SDK Client ──────────────────────────────────────────────

    /**
     * @param {string | null} token
     * @param {boolean} [oauth]
     */
    createClient(token, oauth = false) {
        // The CJS build exports the class itself; the .d.ts only declares it as `default`.
        const Anthropic = /** @type {typeof import('@anthropic-ai/sdk').default} */ (/** @type {unknown} */ (require('@anthropic-ai/sdk')));
        if (oauth) {
            // Subscription/OAuth token → Authorization: Bearer + the oauth beta
            // header. apiKey:null stops the SDK falling back to ANTHROPIC_API_KEY
            // from env and sending both headers (the API 401s when both are set).
            return new Anthropic({
                apiKey: null,
                authToken: token,
                defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
                timeout: SDK_TIMEOUT_MS,
            });
        }
        return new Anthropic({ apiKey: token, timeout: SDK_TIMEOUT_MS });
    }

    /**
     * Resolve the credential + auth mode. In Claude Code OAuth dev mode
     * (BEEFLOW_CLAUDE_CODE_OAUTH=1) the stored apiKey is ignored and a fresh
     * subscription token is read/refreshed from ~/.claude/.credentials.json. A
     * directly-pasted sk-ant-oat… token also flips to OAuth mode (no auto-refresh).
     */
    async _resolveAuth(apiKey) {
        const ccoa = require('./claudeCodeAuth');
        if (ccoa.isEnabled()) {
            return { token: await ccoa.getAccessToken(), oauth: true };
        }
        if (typeof apiKey === 'string' && apiKey.startsWith('sk-ant-oat')) {
            return { token: apiKey, oauth: true };
        }
        return { token: apiKey, oauth: false };
    }

    /**
     * Prepend the Claude Code identity as the first system block (OAuth mode only).
     * Existing system blocks — and their cache_control breakpoints — are preserved
     * after it. Idempotent and safe when there is no system prompt yet.
     */
    _injectClaudeCodeIdentity(params) {
        const idBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY };
        if (Array.isArray(params.system)) {
            if (params.system[0] && params.system[0].text === CLAUDE_CODE_IDENTITY) return;
            params.system = [idBlock, ...params.system];
        } else if (typeof params.system === 'string' && params.system.length) {
            params.system = [idBlock, { type: 'text', text: params.system }];
        } else {
            params.system = [idBlock];
        }
    }

    // ─── Message Normalization ───────────────────────────────────

    normalizeContent(content) {
        if (content == null) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const blocks = content.map(block => {
                // Convert OpenAI image_url → Claude native image block.
                // Preserve cache_control if the caller marked it (directChat
                // tags the last attachment block to extend the cache prefix).
                if (block.type === 'image_url') {
                    const url = typeof block.image_url === 'string'
                        ? block.image_url
                        : block.image_url?.url || '';
                    const preserved = block.cache_control ? { cache_control: block.cache_control } : {};
                    if (url.startsWith('data:')) {
                        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                        if (match) {
                            return {
                                type: 'image',
                                source: { type: 'base64', media_type: match[1], data: match[2] },
                                ...preserved,
                            };
                        }
                    } else if (url.startsWith('http')) {
                        return {
                            type: 'image',
                            source: { type: 'url', url },
                            ...preserved,
                        };
                    }
                    return null; // Skip if unresolvable
                }
                return block;
            }).filter(Boolean);
            // Never hand the SDK an empty content array — Anthropic rejects it and
            // the whole request fails ("Error generating response"). This happened
            // when the only content was an image whose data URL couldn't be parsed,
            // e.g. a pasted image with an unexpected data-URL shape (BFSF-189).
            return blocks.length > 0
                ? blocks
                : [{ type: 'text', text: '[Attachment could not be processed]' }];
        }
        return JSON.stringify(content);
    }

    /**
     * Rebuild the Claude `thinking` / `redacted_thinking` blocks for a stored
     * assistant turn.
     *
     * WHY THIS MATTERS. Extended thinking is not decoration: on a multi-turn
     * conversation the model reads its own prior reasoning back, and Anthropic
     * caches those blocks as part of the message prefix. Dropping them on
     * replay both loses the reasoning and rewrites the prefix, so every later
     * turn is a cache miss AND starts from a thinner context. This adapter used
     * to rebuild them for tool-call turns only, which meant a plain
     * question→answer conversation lost 100% of its reasoning history.
     *
     * Only blocks with a `signature` are replayable — Anthropic rejects an
     * unsigned thinking block — and `redacted_thinking` needs its opaque
     * `data` payload echoed back verbatim (it carries no readable text).
     *
     * @param {ClaudeMessage | null | undefined} m Stored assistant message; `m.thinking` is the
     *   structured part array persisted by the chat runtimes.
     * @returns {Array} Claude content blocks, in the original order.
     */
    replayThinkingBlocks(m) {
        if (!Array.isArray(m?.thinking)) return [];
        const blocks = [];
        for (const t of m.thinking) {
            if (!t || typeof t !== 'object') continue;
            if (t.redacted) {
                // The encrypted payload is the only thing Anthropic accepts here;
                // a redacted block without it cannot be reconstructed.
                if (t.redactedData) blocks.push({ type: 'redacted_thinking', data: t.redactedData });
                continue;
            }
            // The SIGNATURE is what makes a block replayable, not the text.
            // Under `display: 'omitted'` the API returns signed blocks whose
            // `thinking` field is empty and decrypts the signature server-side
            // to reconstruct the reasoning — so requiring non-empty text here
            // would silently drop every block on the models that default to
            // omitted. Round-tripped text is ignored by the API either way.
            if (t.signature) {
                blocks.push({
                    type: 'thinking',
                    thinking: typeof t.text === 'string' ? t.text : '',
                    signature: t.signature,
                });
            }
        }
        return blocks;
    }

    /**
     * @param {Array} messages OpenAI-shape history.
     * @param {{ keepThinking?: boolean }} [opts] `keepThinking`: Replay stored thinking blocks. Set
     *   false when this request runs with thinking off (the blocks would be dead weight) or when
     *   retrying after Anthropic rejected a signature (default true)
     */
    normalizeMessages(messages, opts = {}) {
        const keepThinking = opts.keepThinking !== false;
        const normalized = mergeToolResultRuns(messages
            .filter((m) => m && m.role && m.role !== "system")
            .map((m) => {
                if (m.role === "tool") {
                    // Convert OpenAI tool response → Claude tool_result block
                    const toolUseId = m.tool_call_id || m.toolCallId || m.id;
                    return {
                        role: "user",
                        content: [{
                            type: "tool_result",
                            tool_use_id: toolUseId || "unknown_tool_use_id",
                            content: this.normalizeContent(m.content),
                        }],
                    };
                }
                if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
                    // Convert OpenAI assistant tool_calls → Claude tool_use content blocks.
                    // When the prior turn had extended thinking WITH signatures, Anthropic
                    // requires the thinking blocks to precede the tool_use blocks on replay
                    // or conversation integrity breaks. Unsigned thinking is dropped.
                    const contentBlocks = keepThinking ? this.replayThinkingBlocks(m) : [];
                    if (m.content) {
                        contentBlocks.push({ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
                    }
                    for (const tc of m.tool_calls) {
                        const fn = tc.function || tc;
                        let input = {};
                        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || fn.input || {}); } catch (e) { fallback('core/providers/claude:ClaudeProvider.normalizeMessages', e); /* tool arguments are not valid JSON, send an empty input */ }
                        contentBlocks.push({
                            type: "tool_use",
                            id: tc.id,
                            name: fn.name,
                            input,
                        });
                    }
                    return { role: "assistant", content: contentBlocks };
                }
                const content = this.normalizeContent(m.content);
                if (m.role === "assistant" && keepThinking) {
                    // Plain (no tool call) assistant turn — same replay, so the
                    // model keeps its reasoning across an ordinary chat too.
                    const thinkingBlocks = this.replayThinkingBlocks(m);
                    if (thinkingBlocks.length > 0) {
                        const rest = typeof content === 'string'
                            ? (content.trim() ? [{ type: 'text', text: content }] : [])
                            : content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
                        // A thinking-only assistant turn is not a valid message —
                        // if the answer text is gone there is nothing to anchor
                        // the reasoning to, so drop it rather than 400 the turn.
                        if (rest.length > 0) {
                            return { role: "assistant", content: [...thinkingBlocks, ...rest] };
                        }
                    }
                }
                return { role: m.role, content };
            }));

        // ─── Prompt caching ──────────────────────────────────────────
        // Up to three 5-min breakpoints on the history; see claude/promptCache.js.
        applyPromptCacheBreakpoints(normalized);

        // ─── Drop orphan tool_use / tool_result pairs ───────────────────
        // Anthropic rejects the request with `messages.N.content.0:
        // unexpected tool_use_id` whenever a tool_result references a
        // tool_use_id that doesn't appear in the immediately previous
        // assistant message. This happens after compaction collapses an
        // assistant(tool_use) into a summary while leaving its matching
        // tool_result in the recent window, or when conversation persistence
        // strips tool_calls but keeps the tool messages.
        //
        // We walk the array in order, tracking which tool_use ids the latest
        // assistant message emitted, and drop any tool_result block that
        // references an unknown id. Symmetrically, drop any tool_use block
        // whose result isn't in the immediately following user message — an
        // assistant turn ending in tool_use without a matching result is
        // also rejected by the API. Empty messages get filtered out.
        return repairToolPairs(normalized);
    }

    extractSystem(messages) {
        const systemMessages = messages.filter((m) => m?.role === "system");
        if (!systemMessages.length) return undefined;

        // Per-message blocks let the caller layer caching by stability:
        //   - First system message = stable identity + tooling + project
        //     context. Gets a 1-hour ephemeral breakpoint so an active user
        //     hitting the same agent for an afternoon reads from cache for
        //     hours at -90%, paying the +100% write only once.
        //   - Subsequent system messages (the volatile block: timestamp,
        //     retrieved memory, per-query KB chunks) get NO cache_control so
        //     they don't churn writes. Anthropic still serves the cached
        //     prefix from the first breakpoint.
        //
        // Callers MUST keep block 0 byte-identical across a conversation's
        // turns — see core/agentRuntime/contextBuilder.js for the contract and
        // core/promptCacheStability.test.js for the regression tests. A single
        // changing byte here costs more than not caching at all, because the
        // 1h write premium is charged every turn.
        //
        // Minimum cacheable prefix is model-dependent and NOT monotonic across
        // generations: 512 tokens on Opus 5, 1024 on Opus 4.8 / Sonnet 5,
        // 2048 on Opus 4.7, 4096 on Opus 4.6 / Haiku 4.5. Below the minimum a
        // breakpoint is silently ignored — no error, just no caching.
        const blocks = systemMessages.map((m, i) => {
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            const block = { type: "text", text };
            if (i === 0) {
                block.cache_control = { type: "ephemeral", ttl: "1h" };
            }
            return block;
        });
        return blocks;
    }

    // ─── Thinking/Reasoning ──────────────────────────────────────

    // Claude models that reject sampling params (temperature/top_p/top_k) and
    // manual budget_tokens — adaptive thinking only. Opus 4.6 / Sonnet 4.6
    // still accept temperature + budgets.
    //
    // This must not be a regex spelling the Opus generation as `4-[78]`, which
    // no 5-series id can match: claude-opus-5 would be treated as a legacy
    // 4.x model and sent `temperature: 1` plus `budget_tokens`, both of which
    // Opus 5 answers with a 400. The fact lives in ./claudeModels.js, where
    // an unreleased id still inherits its generation's rules.
    /**
     * @param {string} modelId
     */
    isAdaptiveOnlyReasoning(modelId) {
        return describeClaudeModel(modelId).adaptiveOnly;
    }

    /**
     * @param {string} model
     */
    buildThinking(model, options = {}) {
        return buildThinking(this, model, options);
    }

    /**
     * @param {string} modelId
     */
    supportsReasoning(modelId) {
        // Opus/Sonnet 4.x-5.x and Fable/Mythos support extended thinking.
        // Haiku 4.5 is deliberately excluded — see the catalog note on it.
        return describeClaudeModel(modelId).reasoning;
    }

    /**
     * @param {string} modelId
     */
    supportsVision(modelId) {
        // Claude 3+, 4.x and 5.x all take image input. Two other copies of this
        // check existed (appStudio/aiRuntime.js and agentRuntime/
        // attachmentProcessor.js) and had already drifted apart — the latter
        // silently omitted Sonnet 5 and Fable, disabling the PDF-vision
        // fallback for models we ship. All three now read the same catalog.
        return describeClaudeModel(modelId).vision;
    }

    /**
     * @param {string} modelId
     */
    supportsDocuments(modelId) {
        // Native PDF document blocks ride the same vision capability: the API
        // renders each page and reads its text layer server-side. Anything that
        // can see an image can take a document block.
        return this.supportsVision(modelId);
    }

    /**
     * @param {string} modelId
     */
    supportsContextEditing(modelId) {
        // Context editing (clear_tool_uses_20250919) is available on the
        // Claude 4+ and Claude 5 families; Claude 3.x rejects the parameter.
        return describeClaudeModel(modelId).contextEditing;
    }

    // ─── Tool Normalization ──────────────────────────────────────

    normalizeTools(tools = []) {
        return tools.map((t) => {
            const fn = t.function || t;
            return {
                name: fn.name,
                description: fn.description || "",
                input_schema: fn.parameters || fn.input_schema || {},
            };
        });
    }

    // ─── SDK Params Builder ──────────────────────────────────────

    /**
     * @param {string} model
     */
    _buildSdkParams(model, messages, options = {}) {
        return buildSdkParams(this, model, messages, options);
    }

    /**
     * Per-request headers for beta params attached by _buildSdkParams.
     * Per-request headers REPLACE defaultHeaders with the same name, so in
     * OAuth mode the oauth beta must ride along with the context-management
     * beta (comma-separated list is the documented form).
     * @param {boolean} oauth
     */
    _requestOptionsFor(params, oauth) {
        return requestOptionsFor(params, oauth);
    }

    _isContextManagementRejection(err) {
        return isContextManagementRejection(err);
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored — SDK handles it.
     * @param {string} model
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const { token, oauth } = await this._resolveAuth(apiKey);
        const client = this.createClient(token, oauth);
        // Our own storage URLs must become bytes BEFORE normalization — Anthropic
        // refuses to fetch them (robots.txt) and 400s the entire request.
        const withImages = await inlineInternalImages(messages);
        const params = this._buildSdkParams(model, withImages, options);
        if (oauth) this._injectClaudeCodeIdentity(params);
        await downscaleClaudeMessages(params.messages);

        log.info('[Claude] SDK chat for model:', model);
        /** @type {Message & { _request_id?: string | null; _workspace_id?: string | null; }} */
        let response;
        try {
            response = await client.messages.create(params, this._requestOptionsFor(params, oauth));
        } catch (err) {
            // A replayed thinking block the API won't verify (usually a model
            // switch mid-conversation) — drop the blocks and retry once. They
            // are context, never the request itself.
            if (!options._noThinkingReplay && isThinkingReplayRejection(err)) {
                log.warn('[Claude] thinking replay rejected — retrying without stored thinking blocks:', /** @type {Error} */ (err).message);
                return this.chat(apiKey, baseUrl, model, messages, { ...options, _noThinkingReplay: true });
            }
            // A forced tool_choice on a model the catalog still thinks accepts
            // one: rerun with `auto` plus the instruction rather than failing.
            if (!options._noForcedToolChoice && isForcedToolChoiceRejection(err)
                && ['tool', 'any'].includes(params.tool_choice?.type)) {
                log.warn(`[Claude] forced tool_choice rejected for ${model} — retrying with auto:`, /** @type {Error} */ (err).message);
                return this.chat(apiKey, baseUrl, model, messages, { ...options, _noForcedToolChoice: true });
            }
            // A rejection of the context-management beta (unexpected model /
            // beta drift) must not take down chat for the whole model — strip
            // the param and retry once without it.
            if (!params.context_management || !this._isContextManagementRejection(err)) throw err;
            log.warn('[Claude] context_management rejected — retrying without it:', /** @type {Error} */ (err).message);
            delete params.context_management;
            response = await client.messages.create(params);
        }

        const textContent = response.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('') || null;

        const toolCalls = response.content
            ?.filter(c => c.type === 'tool_use')
            .map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
            }));

        // A refusal (or an over-long request) carries no text, so returning
        // `content: null` here reads downstream as "the model had nothing to
        // say" rather than "the model declined". Give it words.
        let content = textContent;
        if (!content && response.stop_reason === 'refusal') {
            content = refusalMessage(response);
            log.warn('[Claude] request refused —',
                JSON.stringify(response.stop_details || null));
        } else if (!content && isContextWindowStop(response)) {
            content = 'This conversation no longer fits in the model context window.';
            log.warn('[Claude] model_context_window_exceeded');
        } else if (!content && response.stop_reason === 'max_tokens' && (!toolCalls || toolCalls.length === 0)) {
            // Thinking can eat the entire budget before the first visible token;
            // null here reads downstream as "the model had nothing to say".
            content = 'The model hit its output length limit before it could answer. Please try again — a shorter conversation or a higher token budget helps.';
            log.warn('[Claude] max_tokens with no visible output (budget spent before text)');
        }

        return {
            content,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
            stopReason: response.stop_reason,
            stopDetails: response.stop_details || null,
            usage: normalizeUsage('claude', response.usage),
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     * @param {string} model
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const { token, oauth } = await this._resolveAuth(apiKey);
        const client = this.createClient(token, oauth);
        // See chat(): stored images are inlined before normalization.
        const withImages = await inlineInternalImages(messages);
        const params = this._buildSdkParams(model, withImages, options);
        if (oauth) this._injectClaudeCodeIdentity(params);
        await downscaleClaudeMessages(params.messages);

        log.info('[Claude] SDK streaming for model:', model);
        log.info('[Claude] Params:', JSON.stringify({
            model: params.model,
            max_tokens: params.max_tokens,
            temperature: params.temperature,
            thinking: params.thinking || 'disabled',
            output_config: params.output_config || 'n/a',
            tools: params.tools ? `${params.tools.length} tool(s)` : 'none',
            messageCount: params.messages?.length || 0,
        }));

        let textChunks = 0;
        let thinkingChunks = 0;
        let eventCount = 0;
        /** @type {{ id: string; name: string; arguments: string; } | null} */
        let currentToolUse = null; // Track in-progress tool_use block
        /** @type {{ partId: string, redacted: boolean, signature: string|null, redactedData?: string } | null} */
        let currentThinking = null; // Track in-progress thinking / redacted_thinking block
        let thinkingPartCounter = 0;
        /** @type {Record<string, any> | null} */
        let streamUsage = null;
        /** @type {string | null} */
        let stopReason = null;
        /** @type {RefusalStopDetails | null} */
        let stopDetails = null;

        try {
            const stream = await client.messages.stream(params, this._requestOptionsFor(params, oauth));

            for await (const event of stream) {
                eventCount++;
                if (event.type === 'content_block_delta') {
                    if (event.delta?.type === 'text_delta' && event.delta?.text) {
                        textChunks++;
                        onEvent('text', { text: event.delta.text });
                    } else if (event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
                        thinkingChunks++;
                        onEvent('thinking', {
                            text: event.delta.thinking,
                            partId: currentThinking?.partId,
                        });
                    } else if (event.delta?.type === 'signature_delta' && event.delta?.signature) {
                        // Server-side only — signature is persisted onto the thinking block
                        // and echoed back to Anthropic on multi-turn tool flows. Never shown to UI.
                        if (currentThinking) {
                            currentThinking.signature = event.delta.signature;
                            onEvent('thinking_signature', {
                                partId: currentThinking.partId,
                                signature: event.delta.signature,
                            });
                        }
                    } else if (event.delta?.type === 'input_json_delta' && event.delta?.partial_json) {
                        // Accumulate tool call JSON arguments
                        if (currentToolUse) {
                            currentToolUse.arguments += event.delta.partial_json;
                            // Surface the in-progress arguments so callers can live-
                            // stream a tool arg (e.g. notebook_write content) as it is
                            // generated. Consumers that don't handle it ignore it.
                            onEvent('tool_args_delta', { name: currentToolUse.name, partial: currentToolUse.arguments });
                        }
                    }
                } else if (event.type === 'content_block_start') {
                    const blockType = event.content_block?.type;
                    if (blockType === 'tool_use') {
                        // Start accumulating a new tool call
                        currentToolUse = {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            arguments: '',
                        };
                        log.info('[Claude] Tool use block start:', event.content_block.name);
                    } else if (blockType === 'thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: false,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId });
                    } else if (blockType === 'redacted_thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: true,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId, redacted: true });
                        // The opaque payload is the ONLY thing that can be
                        // replayed for a redacted block — there is no readable
                        // text and no signature delta. Persist it the same way
                        // a signature is persisted, or the block is lost for
                        // every later turn.
                        if (event.content_block.data) {
                            currentThinking.redactedData = event.content_block.data;
                            onEvent('thinking_signature', {
                                partId: currentThinking.partId,
                                redactedData: event.content_block.data,
                            });
                        }
                    }
                } else if (event.type === 'content_block_stop') {
                    // Emit accumulated tool call when block ends. Drop a nameless
                    // block, or one whose accumulated arguments aren't valid JSON,
                    // instead of emitting input:{} — a poisoned tool call echoed back
                    // next round can trigger an upstream 400 / spin loop (BFSF-143).
                    if (currentToolUse) {
                        let input;
                        let _drop = false;
                        if (!currentToolUse.name || !String(currentToolUse.name).trim()) {
                            log.warn('[Claude] Dropping nameless streamed tool call');
                            _drop = true;
                        } else {
                            try { input = JSON.parse(currentToolUse.arguments || '{}'); }
                            catch (e) { log.warn(`[Claude] Dropping tool_use ${currentToolUse.name}: invalid JSON args (${/** @type {Error} */ (e).message})`); _drop = true; }
                        }
                        if (!_drop) {
                            onEvent('tool_use', {
                                id: currentToolUse.id,
                                name: currentToolUse.name,
                                input,
                            });
                            log.info(`[Claude] Stream tool_use: ${currentToolUse.name}`);
                        }
                        currentToolUse = null;
                    } else if (currentThinking) {
                        onEvent('thinking_stop', {
                            partId: currentThinking.partId,
                            redacted: currentThinking.redacted || undefined,
                        });
                        currentThinking = null;
                    }
                } else if (event.type === 'message_start') {
                    // normal start
                } else if (event.type === 'message_delta') {
                    // normal delta
                } else if (event.type === 'message_stop') {
                    // normal stop
                } else if (/** @type {{ type?: string }} */ (event).type === 'error') { // not in the SDK's event union; defensive
                    log.error('[Claude] Stream error event:', JSON.stringify(event));
                    onEvent('error', { error: /** @type {{ error?: { message?: string } }} */ (event).error?.message || 'Unknown stream error' });
                }
            }

            // Try to get the final message for usage info
            try {
                const finalMessage = await stream.finalMessage();
                log.info('[Claude] Final message — stop_reason:', finalMessage.stop_reason,
                    'usage:', JSON.stringify(finalMessage.usage));
                // A refused turn streams no text at all. Without this the UI
                // just stops, with no message and no error.
                if (textChunks === 0 && finalMessage.stop_reason === 'refusal') {
                    log.warn('[Claude] stream refused —',
                        JSON.stringify(finalMessage.stop_details || null));
                    onEvent('text', { text: refusalMessage(finalMessage) });
                } else if (textChunks === 0 && isContextWindowStop(finalMessage)) {
                    onEvent('text', { text: 'This conversation no longer fits in the model context window.' });
                }
                stopReason = finalMessage.stop_reason || null;
                stopDetails = finalMessage.stop_details || null;
                if (finalMessage.usage) {
                    // Same normaliser as the non-streaming chat(): input_tokens
                    // stays the uncached remainder (usageNormalizer header), the
                    // 5m/1h cache-write split is carried instead of one
                    // "dominant" TTL, and tier/geo/server-tool counts ride along.
                    streamUsage = {
                        ...normalizeUsage('claude', finalMessage.usage),
                        stop_reason: finalMessage.stop_reason || null,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        log.info(`[Claude] ⚡ Cache hit: ${streamUsage.cached_tokens} cached input tokens (saved ~${Math.round(streamUsage.cached_tokens * 0.9)} token-equivalents)`);
                    }
                    if (streamUsage.cache_creation_tokens > 0) {
                        log.info(`[Claude] 📦 Cache created: ${streamUsage.cache_creation_tokens} tokens (5m=${streamUsage.cache_creation_5m_tokens}, 1h=${streamUsage.cache_creation_1h_tokens})`);
                    }
                }
            } catch (e) { fallback('core/providers/claude:ClaudeProvider.stream', e); /* already consumed */ }
        } catch (err) {
            // A rejection of the context-management beta would otherwise loop
            // forever in upstream retries (the 400 is permanent for identical
            // params). Safe to restart here: a connect-time 400 fires before
            // any event was emitted downstream.
            if (params.context_management && eventCount === 0 && this._isContextManagementRejection(err)) {
                log.warn('[Claude] context_management rejected — retrying stream without it:', /** @type {Error} */ (err).message);
                return this.stream(apiKey, baseUrl, model, messages, { ...options, _noContextEditing: true }, onEvent);
            }
            // Same connect-time-only guard for an unverifiable thinking block:
            // safe to restart because nothing has been emitted downstream yet.
            if (eventCount === 0 && !options._noThinkingReplay && isThinkingReplayRejection(err)) {
                log.warn('[Claude] thinking replay rejected — retrying stream without stored thinking blocks:', /** @type {Error} */ (err).message);
                return this.stream(apiKey, baseUrl, model, messages, { ...options, _noThinkingReplay: true }, onEvent);
            }
            // See chat(): a forced tool_choice the model refuses reruns with
            // `auto` — safe here for the same connect-time reason.
            if (eventCount === 0 && !options._noForcedToolChoice && isForcedToolChoiceRejection(err)
                && ['tool', 'any'].includes(params.tool_choice?.type)) {
                log.warn(`[Claude] forced tool_choice rejected for ${model} — retrying stream with auto:`, /** @type {Error} */ (err).message);
                return this.stream(apiKey, baseUrl, model, messages, { ...options, _noForcedToolChoice: true }, onEvent);
            }
            log.error('[Claude] Stream error:', /** @type {Error} */ (err).message);
            if (err.status) log.error('[Claude] Error status:', err.status);
            if (err.error) log.error('[Claude] API error body:', JSON.stringify(err.error));
            // Enrich the error with status info for upstream retry classification
            if (err.status && !/** @type {Error} */ (err).message.includes(`API error ${err.status}`)) {
                /** @type {Error} */ (err).message = `API error ${err.status}: ${JSON.stringify(err.error || /** @type {Error} */ (err).message)}`;
            }
            throw err;  // Let retryStreamCall handle retry/classify
        }

        log.info(`[Claude] Stream complete — ${eventCount} events, ${textChunks} text chunks, ${thinkingChunks} thinking chunks`);
        onEvent('done', { ...(streamUsage || {}), stopReason, stopDetails });
    }

    /**
     * List models via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async listModels(apiKey, _baseUrl) {
        try {
            const { token, oauth } = await this._resolveAuth(apiKey);
            const client = this.createClient(token, oauth);
            const response = await client.models.list();
            return (response.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
        } catch (e) {
            log.error('[Claude] SDK listModels failed:', /** @type {Error} */ (e).message);
            return [];
        }
    }
}

module.exports = ClaudeProvider;

/** @typedef {import('@anthropic-ai/sdk/resources/messages.js').Message} Message */

/** @typedef {import('@anthropic-ai/sdk/resources/messages.js').RefusalStopDetails} RefusalStopDetails */

/**
 * @typedef {import('./claude/params').SdkParams} SdkParams
 * @typedef {import('./base').OnEvent} OnEvent
 * @typedef {{ type?: string, text?: string, cache_control?: unknown, [k: string]: unknown }} ClaudeBlock
 * @typedef {{ id?: string, name?: string, arguments?: unknown, input?: unknown, function?: { name?: string, arguments?: unknown, input?: unknown } }} ToolCallIn
 * @typedef {{ role?: string, content?: unknown, tool_call_id?: string, toolCallId?: string, id?: string, tool_calls?: ToolCallIn[], thinking?: unknown }} ClaudeMessage
 * @typedef {{ maxTokens?: number, temperature?: number, tools?: ToolDef[], toolChoice?: unknown, reasoningEffort?: string, budgetTokens?: number, responseFormat?: { type?: string, json_schema?: { schema?: unknown } }, timeoutMs?: number, signal?: AbortSignal | null, _noThinkingReplay?: boolean, _noForcedToolChoice?: boolean, _noContextEditing?: boolean }} ClaudeOptions
 * @typedef {{ type?: string, name?: string, description?: string, parameters?: unknown, input_schema?: unknown, function?: { name?: string, description?: string, parameters?: unknown, input_schema?: unknown } }} ToolDef
 */
