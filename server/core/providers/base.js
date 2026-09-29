// @typecheck
/**
 * Base Provider Adapter
 * 
 * Shared interface that all provider adapters implement.
 * Provides default implementations using fetch + SSE parsing for OpenAI-compatible APIs.
 * 
 * Subclasses can override:
 * - buildRequestBody() — provider-specific request format
 * - getHeaders() — auth header format
 * - getChatCompletionsPath() — endpoint path
 * - chat() — non-streaming completion
 * - stream() — streaming completion with normalized events
 * - listModels() — fetch available models
 */

const { stripInternalFields } = require('../../utils/messageUtils');
const { parseGemmaArgs } = require('../llm/leakedToolCalls');
const log = require('../../telemetry/log');

// Parity with claude.js (`?? DEFAULT_MAX_TOKENS`). Without a default, a
// caller that passed no cap let a self-hosted model generate until its
// context ran out — one runaway reply held the single llama.cpp slot for
// minutes. 8192 covers every chat tier's ceiling below the thinking tiers,
// which always pass an explicit maxTokens anyway.
const DEFAULT_MAX_TOKENS = 8192;

class BaseProvider {
    constructor(name) {
        this.name = name;
    }

    // ─── Request Building ───────────────────────────────────────────

    /**
     * Build a provider-specific request body for chat completions.
     */
    buildRequestBody(model, messages, options = {}) {
        // OpenAI-compatible endpoints (Scaleway, vLLM, Ollama, LM Studio, …)
        // get this body verbatim, so the internal companion fields the chat
        // runtimes carry on a message — the structured `thinking` parts,
        // attachment sidecars — have to come off first. Adapters that build
        // their own content blocks (Claude, Google) read `thinking` before
        // this point and rebuild it in their own wire format.
        const body = { model, messages: stripInternalFields(messages) };

        // camelCase is the adapter contract; the snake_case alias is honoured
        // because two call sites passed `max_tokens` and were silently
        // uncapped. `extraBody` (applied last) still overrides.
        body.max_tokens = options.maxTokens ?? options.max_tokens ?? DEFAULT_MAX_TOKENS;
        if (options.temperature !== undefined) body.temperature = options.temperature;
        if (options.stream !== undefined) body.stream = options.stream;
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            body.tool_choice = options.toolChoice || 'auto';
        }
        if (options.extraBody) Object.assign(body, options.extraBody);

        return body;
    }

    /**
     * Get auth headers for this provider.
     */
    getHeaders(apiKey) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        return headers;
    }

    /**
     * Get the API endpoint path for chat completions.
     */
    getChatCompletionsPath() {
        return '/chat/completions';
    }

    // ─── Model capabilities ──────────────────────────────────────────

    isRestrictedModel(_modelId) { return false; }
    supportsReasoning(_modelId) { return false; }
    supportsVision(_modelId) { return false; }
    // Native document blocks ({type:'document'} with raw PDF bytes). Only
    // Anthropic's API understands them — an OpenAI-compatible endpoint answers
    // an unknown content block with a 400 that fails the whole request, so
    // callers must gate on this rather than trying and catching.
    supportsDocuments(_modelId) { return false; }

    // Can this adapter GUARANTEE a response matching `schema`, via native
    // structured output (`response_format` / `text.format` with a JSON schema)?
    //
    // Deliberately asks about the schema, not just the provider: OpenAI's
    // structured outputs only constrain decoding for schemas that are fully
    // closed and fully required, and answer anything looser with prose. A
    // provider-level yes/no would send those loose schemas down a route that
    // cannot deliver. False by default → llmClient forces a tool call instead.
    supportsStructuredOutput(_modelId, _schema) { return false; }

    // ─── High-Level API ──────────────────────────────────────────────

    /**
     * Non-streaming chat completion.
     * @param {string} apiKey
     * @param {string} baseUrl - Provider base URL (e.g. https://api.openai.com/v1)
     * @param {string} model
     * @param {Array} messages
     * @param {object} options - Same as buildRequestBody options
     * @returns {Promise<{content: string|null, toolCalls: Array|null, usage: object}>}
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const headers = this.getHeaders(apiKey);
        const body = this.buildRequestBody(model, messages, { ...options, stream: false });
        const normalizedUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
        const url = `${normalizedUrl}${this.getChatCompletionsPath()}`;

        // Honor options.timeoutMs — without it a stalled connection to a
        // generic OpenAI-compatible endpoint hangs the await forever, which in
        // the background meeting-notes workers outlives the job lease and
        // wedges the worker.
        const timeout = this._requestTimeout(options.timeoutMs);
        const fetchSignal = this._combineSignals(timeout.controller?.signal, options.signal);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(fetchSignal ? { signal: fetchSignal } : {}),
            });

            if (!response.ok) {
                const errorText = await response.text();
                this._recordHttpError(model, response.status);
                throw new Error(`${this.name} API error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            return this._parseNonStreamingResponse(data, options);
        } finally {
            timeout.clear();
        }
    }

    /**
     * A one-shot request timeout: `controller` aborts after `timeoutMs`, with
     * a message that says so. No timeout (0 or unset) means no controller.
     * Call `clear()` when the request is over.
     */
    _requestTimeout(timeoutMs) {
        const ms = Number(timeoutMs) || 0;
        const controller = ms > 0 ? new AbortController() : null;
        const timer = controller
            ? setTimeout(() => controller.abort(new Error(`${this.name} request timed out after ${ms}ms`)), ms)
            : null;
        return { controller, clear: () => { if (timer) clearTimeout(timer); } };
    }

    /**
     * A stall watchdog for a stream: armed on creation, and `arm()` restarts
     * the countdown, so call it on every chunk. A slow-but-alive stream is
     * never cut off while a wedged one is. No timeout (0 or unset) means no
     * controller. Call `clear()` when the stream is over.
     */
    _stallWatchdog(timeoutMs) {
        const ms = Number(timeoutMs) || 0;
        const controller = ms > 0 ? new AbortController() : null;
        let timer = null;
        const arm = () => {
            if (!controller) return;
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new Error(`${this.name} stream stalled for ${ms}ms`)), ms);
        };
        arm();
        return { controller, arm, clear: () => { if (timer) clearTimeout(timer); } };
    }

    /**
     * OTel provider-error counter. Best-effort, and the classified status
     * only: never the error body, which may echo prompt content.
     */
    _recordHttpError(model, status) {
        try {
            require('../../telemetry/metrics').recordLlmError({
                provider: this.name, model,
                errorType: `http_${Math.floor(status / 100)}xx`,
            });
        } catch (_) { /* telemetry is best-effort */ }
    }

    /**
     * Does this adapter hand back the model's RAW chain of thought, rather
     * than the provider-generated summary the hosted reasoning APIs return?
     *
     * Only raw-reasoning adapters can honour the tier's "Reasoning Summary"
     * switch themselves. On OpenAI the switch decides whether a summary is
     * requested at all, so there is nothing left to filter; on a local runtime
     * the thinking arrives unconditionally and this is the only place it can
     * be withheld.
     */
    surfacesRawReasoning() {
        return false;
    }

    /** Should the model's reasoning reach the caller at all? */
    _wantsThinking(options = {}) {
        return !(this.surfacesRawReasoning() && options.reasoningSummary === false);
    }

    /**
     * Parse a non-streaming response into normalized format.
     * Override in subclasses for different response shapes.
     *
     * BFSF-263: reasoning is separated instead of leaking into content —
     * either from a dedicated reasoning field or from in-band <think>…</think>
     * tags (Qwen/DeepSeek distills served via generic OpenAI-compatible
     * endpoints). Mirrors MistralProvider's { content, thinking } result shape.
     *
     * Two spellings of that field are in the wild: `reasoning_content`
     * (DeepSeek, vLLM) and `reasoning` (Ollama). Ollama emits ONLY the
     * latter, so reading one name alone dropped the thinking of every model
     * served through it.
     */
    _parseNonStreamingResponse(data, options = {}) {
        const message = data.choices?.[0]?.message;
        const { extractThinkBlocks } = require('./thinkTagStream');
        const { content, thinking: tagThinking } = extractThinkBlocks(message?.content ?? null);
        // Only a plain string is thinking text. Mistral-style structured
        // reasoning arrives inside `content` and is handled there; letting a
        // non-string through here would stringify an object into the block.
        const rawReasoning = message?.reasoning_content || message?.reasoning;
        const reasoning = typeof rawReasoning === 'string' ? rawReasoning : null;
        // Reasoning is SPLIT OFF content above either way — it never leaks
        // into the answer. The switch only decides whether it is handed back.
        const thinking = (this._wantsThinking(options) ? [reasoning, tagThinking] : []).filter(Boolean).join('\n') || null;
        // `stop_reason` (the codebase-wide name; OpenAI spells it
        // finish_reason) lets a caller tell "the model was done" from "the
        // model was cut off at max_tokens" — the same reply otherwise.
        const stopReason = data.choices?.[0]?.finish_reason;
        return {
            content: content || null,
            ...(thinking ? { thinking } : {}),
            toolCalls: message?.tool_calls || null,
            usage: data.usage || null,
            ...(stopReason ? { stop_reason: stopReason } : {}),
            raw: data,
        };
    }

    /**
     * Streaming chat completion with normalized event callbacks.
     * @param {string} apiKey
     * @param {string} baseUrl
     * @param {string} model
     * @param {Array} messages
     * @param {object} options
     * @param {function} onEvent - Called with (eventType, data):
     *   - ('text', { text }) — text content delta
     *   - ('thinking', { text }) — reasoning/thinking delta
     *   - ('tool_use', { id, name, input }) — tool call
     *   - ('done', { usage }) — stream complete
     *   - ('error', { error }) — stream error
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const headers = this.getHeaders(apiKey);
        const body = this.buildRequestBody(model, messages, { ...options, stream: true });
        const normalizedUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
        const url = `${normalizedUrl}${this.getChatCompletionsPath()}`;

        // Honor options.timeoutMs as a body-stall watchdog: the timer re-arms
        // on every received chunk, so a slow-but-alive stream is never cut off
        // while a wedged connection is.
        const watchdog = this._stallWatchdog(options.timeoutMs);
        // options.signal is the caller's own abort — in the chat runtimes the
        // client's disconnect. Without it a closed tab left a self-hosted
        // model generating to max_tokens for nobody, on the only slot there
        // is; the agent runtime's raw-fetch path had it, the adapter path
        // did not.
        const fetchSignal = this._combineSignals(watchdog.controller?.signal, options.signal);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(fetchSignal ? { signal: fetchSignal } : {}),
            });

            if (!response.ok) {
                const errorText = await response.text();
                this._recordHttpError(model, response.status);
                throw new Error(`${this.name} API error ${response.status}: ${errorText}`);
            }

            const { arm } = watchdog;
            const watchedBody = watchdog.controller
                ? (async function* (src) { for await (const chunk of src) { arm(); yield chunk; } })(response.body)
                : response.body;
            await this._parseSseStream(watchedBody, onEvent, options);
        } finally {
            watchdog.clear();
        }
    }

    /**
     * One AbortSignal out of the watchdog's and the caller's, or undefined
     * when there is neither — so the no-signal request shape is unchanged.
     */
    _combineSignals(...signals) {
        const live = signals.filter(Boolean);
        if (live.length === 0) return undefined;
        if (live.length === 1) return live[0];
        return AbortSignal.any(live);
    }

    /**
     * The event half of the stream contract, shared by every streaming path:
     * the SSE parser below and adapters that stream through a vendor SDK
     * (mistral.js). One implementation, so a fix to tool-call accumulation or
     * thinking brackets reaches every provider at once.
     *
     *  - Tool calls arrive as FRAGMENTS (see accumulateToolCalls) and leave as
     *    one 'tool_use' each, `input` parsed — or 'tool_use_invalid' when the
     *    arguments never became JSON, even after the loose parser.
     *  - Thinking is bracketed by 'thinking_start'/'thinking_stop' under one
     *    `partId`, and withheld entirely when `_wantsThinking` says so.
     *
     * @param {function} onEvent
     * @param {object} options - the adapter options (reasoningSummary is read)
     * @param {string} thinkingPartId
     */
    _createStreamEmitter(onEvent, options = {}, thinkingPartId) {
        let thinkingOpen = false;

        // Streamed tool calls arrive as FRAGMENTS that must be accumulated and
        // parsed once, not forwarded per-delta. The contract documented on
        // `stream()` is one 'tool_use' per call with `input` already a parsed
        // OBJECT — every sibling adapter (openai.js, claude.js, mistral.js,
        // google.js) honours it, and the builder's parseToolArgs JSON.parses
        // whatever arrives. Emitting each fragment with `input` set to the raw
        // arguments STRING produced two silent failures on every provider that
        // inherits this parser (all ten self-hosted runtimes, plus Scaleway):
        // a whole-call-in-one-delta shape (Ollama) yielded one tool call whose
        // args parsed to a string, so every field read `undefined` and the
        // automation builder added an empty step; a fragmented shape (vLLM,
        // llama.cpp, LM Studio) yielded one bogus call per fragment, most of
        // them nameless. Mirrors openai.js:348-395.
        const toolCallAccumulator = {};
        const accumulateToolCalls = (toolCalls) => {
            for (const tc of toolCalls) {
                // `index` is how the OpenAI SSE protocol correlates fragments,
                // but not every runtime sends it. Without one, a delta that
                // carries neither an id nor a name is a continuation of the
                // call in flight; anything else opens a new slot.
                let idx = tc.index;
                if (idx === undefined || idx === null) {
                    const keys = Object.keys(toolCallAccumulator);
                    const isContinuation = !tc.id && !tc.function?.name;
                    idx = isContinuation && keys.length ? keys[keys.length - 1] : keys.length;
                }
                if (!toolCallAccumulator[idx]) {
                    toolCallAccumulator[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                }
                const acc = toolCallAccumulator[idx];
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                    acc.arguments += tc.function.arguments;
                    // Lets callers live-stream a long argument as it generates.
                    // Ignored by consumers that don't handle it.
                    if (acc.name) onEvent('tool_args_delta', { name: acc.name, partial: acc.arguments });
                }
            }
        };
        // Idempotent: the accumulator is drained, so the finish_reason flush and
        // the end-of-stream backstop cannot emit the same call twice. The
        // backstop matters because not every runtime sends a finish_reason.
        const flushToolCalls = () => {
            for (const key of Object.keys(toolCallAccumulator)) {
                const tc = toolCallAccumulator[key];
                delete toolCallAccumulator[key];
                // Drop rather than repair: a nameless call, or one whose
                // arguments never became valid JSON, is echoed back to the
                // provider next round and can trigger a 400 or a spin loop.
                if (!tc.name || !String(tc.name).trim()) {
                    log.warn(`[${this.name}] Dropping nameless streamed tool call`);
                    continue;
                }
                let input;
                let repaired = false;
                try {
                    input = JSON.parse(tc.arguments || '{}');
                } catch (e) {
                    // Not valid JSON. Before giving up, the loose parser: it
                    // reads a batch cut at max_tokens right after a complete
                    // entry (closing the open brackets), bare-word values and
                    // Gemma's own fence syntax — the shapes the container log
                    // showed being dropped (`builder_set_plan … position 125`,
                    // `app_update_component … position 1322`). What it returns
                    // is every element that was complete on the wire and
                    // nothing invented (core/llm/leakedToolCalls, grammar note),
                    // and the event says so with `_repaired` so a consumer can
                    // tell the model what happened to its call.
                    const loose = parseGemmaArgs(typeof tc.arguments === 'string' ? tc.arguments : '');
                    if (loose && typeof loose === 'object') {
                        log.warn(`[${this.name}] Repaired tool_use ${tc.name}: arguments were not valid JSON (${e.message}); read with the loose parser`);
                        input = loose;
                        repaired = true;
                    } else {
                        // Still dropped from `tool_use` — echoing a half-written
                        // call back to the provider next round is the 400/spin-loop
                        // the note above describes. But a console warning is the
                        // only trace it left, so the caller saw a round with no
                        // tool call and no text: indistinguishable from the model
                        // going quiet, and unfixable because the model was never
                        // told. Announce it separately; consumers that don't listen
                        // are unaffected, and the ones that do (the builders) can
                        // ask for just that call again.
                        log.warn(`[${this.name}] Dropping tool_use ${tc.name}: invalid JSON args (${e.message})`);
                        onEvent('tool_use_invalid', {
                            id: tc.id,
                            name: tc.name,
                            arguments: typeof tc.arguments === 'string' ? tc.arguments : '',
                            error: e.message,
                        });
                        continue;
                    }
                }
                onEvent('tool_use', { id: tc.id, name: tc.name, input, ...(repaired ? { _repaired: true } : {}) });
            }
        };
        const wantThinking = this._wantsThinking(options);
        const openThinking = () => {
            if (wantThinking && !thinkingOpen) {
                thinkingOpen = true;
                onEvent('thinking_start', { partId: thinkingPartId });
            }
        };
        // Every thinking delta goes through here, so withholding it is one
        // decision rather than three. Suppressed thinking is DISCARDED, never
        // rerouted into the visible answer.
        const emitThinking = (text) => {
            if (!wantThinking || !text) return;
            openThinking();
            onEvent('thinking', { text, partId: thinkingPartId });
        };
        const closeThinking = () => {
            if (thinkingOpen) {
                thinkingOpen = false;
                onEvent('thinking_stop', { partId: thinkingPartId });
            }
        };

        return { accumulateToolCalls, flushToolCalls, openThinking, emitThinking, closeThinking };
    }

    /**
     * Parse an SSE stream (Chat Completions format).
     * Override in subclasses for different SSE event formats.
     */
    async _parseSseStream(body, onEvent, options = {}) {
        const decoder = new TextDecoder();
        let buffer = '';
        let streamUsage = null;
        // Last non-null finish_reason seen ('stop' | 'length' | 'tool_calls').
        // Reported on the 'done' payload as `stop_reason` — the name every
        // other adapter uses — so a tool loop can see that a reply was cut off
        // at max_tokens instead of reading the silence as a final answer.
        let stopReason = null;
        // llama-server's per-request `timings` (prompt_n / cache_n /
        // prompt_ms / predicted_n / predicted_ms) are the ground truth for
        // whether the prompt cache hit — `cache_n` is how many prompt tokens
        // were reused. Forwarded on 'done' when present so the chat route can
        // log them; other runtimes never send the field.
        let streamTimings = null;
        const donePayload = () => ({
            ...(streamUsage || {}),
            ...(stopReason ? { stop_reason: stopReason } : {}),
            ...(streamTimings ? { timings: streamTimings } : {}),
        });
        const { accumulateToolCalls, flushToolCalls, openThinking, emitThinking, closeThinking } =
            this._createStreamEmitter(onEvent, options, 'mistral-0');

        // BFSF-263: OSS reasoning models behind generic OpenAI-compatible
        // endpoints emit their chain-of-thought as literal <think>…</think>
        // text at the start of the turn — previously streamed verbatim into
        // the visible answer. The splitter reroutes it into the same typed
        // thinking events the native adapters use.
        const { createThinkTagSplitter } = require('./thinkTagStream');
        const splitter = createThinkTagSplitter({
            onText: (text) => { closeThinking(); onEvent('text', { text }); },
            onThinkingStart: openThinking,
            onThinking: (text) => emitThinking(text),
            onThinkingStop: closeThinking,
        });

        for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    splitter.flush();
                    closeThinking();
                    flushToolCalls();
                    onEvent('done', donePayload());
                    return;
                }

                try {
                    const parsed = JSON.parse(data);

                    // Usage arrives in its own trailing chunk (one with an
                    // empty `choices`), and only when the request asked for it
                    // via stream_options.include_usage. Read it before the
                    // delta guard below, or it is skipped and the whole
                    // streamed turn is logged — and billed — as zero tokens.
                    if (parsed.timings && typeof parsed.timings === 'object') {
                        const t = parsed.timings;
                        streamTimings = {
                            prompt_n: t.prompt_n, cache_n: t.cache_n, prompt_ms: t.prompt_ms,
                            predicted_n: t.predicted_n, predicted_ms: t.predicted_ms,
                        };
                    }
                    if (parsed.usage) {
                        streamUsage = {
                            prompt_tokens: parsed.usage.prompt_tokens || 0,
                            completion_tokens: parsed.usage.completion_tokens || 0,
                            total_tokens: parsed.usage.total_tokens || 0,
                            // llama.cpp reports reuse in timings.cache_n, not in
                            // prompt_tokens_details — read both so a local turn
                            // does not log every prompt as fully uncached.
                            cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens
                                ?? (Number.isFinite(streamTimings?.cache_n) ? streamTimings.cache_n : 0),
                            reasoning_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens || 0,
                        };
                    }

                    // Prefill progress (llama-server, `return_progress: true`):
                    // its own chunk, `choices` EMPTY, carrying how far the
                    // prompt has been read and how much of it the prefix cache
                    // served. Forwarded as a typed event so the builder can
                    // draw a real progress bar for a 200 s first-round prefill.
                    // Read BEFORE the delta guard — the empty `choices` makes
                    // that guard `continue`, which is exactly right for the
                    // rest of the chunk (nothing to say, nothing to flush).
                    if (parsed.prompt_progress && typeof parsed.prompt_progress === 'object') {
                        const p = parsed.prompt_progress;
                        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
                        onEvent('prompt_progress', {
                            total: num(p.total), cache: num(p.cache), processed: num(p.processed), time_ms: num(p.time_ms),
                        });
                    }

                    // Read the finish reason BEFORE the delta guard: llama.cpp
                    // sends `delta: {}` on its finish chunk, but a runtime that
                    // omits `delta` there would otherwise lose the reason.
                    const chunkFinish = parsed.choices?.[0]?.finish_reason;
                    if (chunkFinish) stopReason = chunkFinish;

                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    // Dedicated reasoning field: `reasoning_content` (DeepSeek,
                    // vLLM) or `reasoning` (Ollama). When present, tag
                    // detection is disabled so models emitting BOTH never
                    // produce doubled thinking.
                    const deltaReasoning = delta.reasoning_content || delta.reasoning;
                    if (typeof deltaReasoning === 'string' && deltaReasoning) {
                        splitter.disableTagDetection();
                        emitThinking(deltaReasoning);
                    }

                    if (delta.content !== undefined && delta.content !== null) {
                        if (typeof delta.content === 'string') {
                            splitter.push(delta.content);
                        } else if (Array.isArray(delta.content)) {
                            // Mistral reasoning model — array of structured chunks
                            for (const block of delta.content) {
                                if (block.type === 'thinking' && Array.isArray(block.thinking)) {
                                    const text = block.thinking
                                        .filter(t => t.type === 'text' && t.text)
                                        .map(t => t.text)
                                        .join('');
                                    if (text) {
                                        emitThinking(text);
                                    }
                                } else if (block.type === 'text' && block.text) {
                                    closeThinking();
                                    onEvent('text', { text: block.text });
                                }
                            }
                        }
                    }

                    // Tool calls in streaming — accumulated, not forwarded.
                    if (delta.tool_calls) {
                        closeThinking();
                        accumulateToolCalls(delta.tool_calls);
                    }

                    const finishReason = parsed.choices?.[0]?.finish_reason;
                    if (finishReason === 'tool_calls' || finishReason === 'stop') {
                        flushToolCalls();
                    }
                } catch (e) {
                    // Skip malformed JSON chunks
                }
            }
        }

        splitter.flush();
        closeThinking();
        flushToolCalls();
        onEvent('done', donePayload());
    }

    /**
     * Fetch available models from this provider.
     * @param {string} apiKey
     * @param {string} baseUrl
     * @param {object} [_options] - Adapter-specific (Vertex: project, location, …); unused here
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async listModels(apiKey, baseUrl, _options = {}) {
        const headers = this.getHeaders(apiKey);
        const modelsUrl = baseUrl.endsWith('/v1')
            ? `${baseUrl}/models`
            : `${baseUrl}/v1/models`;

        const response = await fetch(modelsUrl, { headers });
        if (!response.ok) return [];

        const data = /** @type {{ data?: Array<{ id: string }> }} */ (await response.json());
        return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    }
}

module.exports = BaseProvider;
