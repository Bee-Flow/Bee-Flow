// @typecheck
/**
 * Mistral Provider Adapter — official `@mistralai/mistralai` SDK, v2.
 *
 * v2 is an ES module; Node 22 loads it through require() (no top-level await
 * in the package), so this stays a plain CommonJS require.
 *
 * What the SDK does NOT do for us, and this file does:
 *
 *  - The request schema STRIPS every key it does not know, silently. Params
 *    must be camelCase SDK names (`reasoningEffort`, `promptCacheKey`, …); a
 *    snake_case or misspelt key never reaches the wire. The 1.x schema had no
 *    `reasoningEffort` at all, so for months no effort reached Mistral while
 *    the code looked fine. mistral.test.js runs our params through the SDK's
 *    own outbound schema for exactly that reason.
 *  - The stream contract every adapter shares (base.js `_createStreamEmitter`):
 *    one 'tool_use' per call with parsed input, 'tool_use_invalid' for
 *    arguments that are not JSON, bracketed thinking with a partId, and a flat
 *    snake_case 'done' payload with `cached_tokens` and `stop_reason`.
 *  - Timeouts and aborts. v2 cuts every request at 300 s unless told
 *    otherwise, which would end a long reasoning stream mid-answer; the client
 *    is built with no SDK timeout and the adapter owns both: a total timeout
 *    for chat(), a stall watchdog for stream(), each combined with the
 *    caller's signal.
 *  - Errors the retry layer can classify: `mistral API error <status>: …`,
 *    like base.js, instead of the SDK's "API error occurred: Status 429".
 *  - Tool-call ids. Mistral accepts only `^[a-zA-Z0-9]{9}$` and answers
 *    anything else with a 400, which is what an id from another provider
 *    (Claude's `toolu_…`) or a generated fallback looks like. Ids are mapped
 *    deterministically, so a pair keeps matching and the prompt prefix stays
 *    byte-identical across turns — Mistral caches on that prefix.
 *
 * Reasoning is a switch on Mistral Small 4 and Medium 3.5 (`reasoningEffort`);
 * the vocabulary per model lives in ./mistralModels.js.
 */

const crypto = require('node:crypto');
const BaseProvider = require('./base');
const { stripInternalFields } = require('../../utils/messageUtils');
const {
    MISTRAL_DEFAULT_SERVER_URL,
    describeMistralModel,
    normalizeMistralEffort,
    rememberMistralCapabilities,
} = require('./mistralModels');
const log = require('../../telemetry/log');

// Parity with base.js: without a cap a runaway reply generates until the
// context window is full.
const DEFAULT_MAX_TOKENS = 8192;
// A reasoning turn spends tokens thinking before it answers; a ceiling sized
// for a plain answer can be used up by the thinking alone and return nothing.
// Same floor claude.js applies to adaptive thinking.
const REASONING_MIN_MAX_TOKENS = 16384;
const THINKING_PART_ID = 'mistral-0';
const TOOL_CALL_ID_RE = /^[a-zA-Z0-9]{9}$/;
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A tool-call id Mistral accepts: exactly nine letters or digits.
 * An id already in that shape is kept; anything else is hashed, so the same
 * input always gives the same id (the call and its result stay paired, and
 * the replayed history stays byte-identical for the prompt cache).
 */
function toMistralToolCallId(id) {
    const raw = typeof id === 'string' ? id : String(id ?? '');
    if (TOOL_CALL_ID_RE.test(raw)) return raw;
    const digest = crypto.createHash('sha256').update(raw).digest();
    let out = '';
    for (let i = 0; out.length < 9; i++) out += BASE62[digest[i] % 62];
    return out;
}

/** The SDK fills a missing id with the STRING "null". */
function realId(id) {
    return typeof id === 'string' && id && id !== 'null' ? id : '';
}

/** `function.arguments` comes back as a string or an already-parsed object. */
function argumentsString(args) {
    if (typeof args === 'string') return args;
    if (args === undefined || args === null) return '';
    return JSON.stringify(args);
}

/**
 * The server URL to hand the SDK, or undefined for its default.
 *
 * Only Mistral's own hosts are honoured (api.mistral.ai and the regional
 * api.eu / api.us endpoints). Until v2 this adapter ignored `baseUrl`
 * entirely, so a stored provider URL was never tested against anything;
 * honouring an arbitrary one now could send a working setup somewhere else.
 */
function resolveServerUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return undefined;
    let url;
    try {
        url = new URL(baseUrl.trim());
    } catch (_) {
        return undefined;
    }
    if (!/(^|\.)mistral\.ai$/i.test(url.hostname)) {
        log.warn(`[Mistral] Ignoring base URL ${url.origin}: not a Mistral host; using ${MISTRAL_DEFAULT_SERVER_URL}`);
        return undefined;
    }
    const origin = url.origin.toLowerCase();
    return origin === MISTRAL_DEFAULT_SERVER_URL ? undefined : origin;
}

/**
 * Only a conversation key goes to Mistral as `prompt_cache_key`. The chat
 * runtime falls back to the user id when there is no conversation yet, and
 * Mistral's docs ask for no personal data in the key.
 */
function conversationCacheKey(key) {
    return typeof key === 'string' && key.startsWith('conv-') ? key : undefined;
}

/**
 * Usage in the stack's snake_case shape.
 *
 * `prompt_tokens` stays the FULL input — cached tokens are a subset of it and
 * modelCosts subtracts them itself (modelCosts `_uncachedInputTokens`).
 * Fields the SDK schema does not name arrive raw, so the cached and reasoning
 * counts are read in the API's own spelling (and the camelCase one, in case a
 * later SDK names them).
 */
function toSnakeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    /** @type {Record<string, any>} */
    const u = usage;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
        prompt_tokens: num(u.promptTokens ?? u.prompt_tokens),
        completion_tokens: num(u.completionTokens ?? u.completion_tokens),
        total_tokens: num(u.totalTokens ?? u.total_tokens),
        cached_tokens: num(
            u.prompt_tokens_details?.cached_tokens
            ?? u.promptTokensDetails?.cachedTokens
            ?? u.num_cached_tokens
            ?? u.numCachedTokens
        ),
        reasoning_tokens: num(
            u.completion_tokens_details?.reasoning_tokens
            ?? u.completionTokensDetails?.reasoningTokens
        ),
    };
}

/**
 * `finish_reason` as the stack's `stop_reason`. `model_length` is Mistral's
 * "the context window ran out": a truncation like `length`, and only `length`
 * is in the truncation set (core/llm/toolLoop.js).
 */
function toStopReason(finishReason) {
    if (!finishReason || typeof finishReason !== 'string') return null;
    return finishReason === 'model_length' ? 'length' : finishReason;
}

/** Text of a thinking chunk: its nested text chunks, joined. */
function thinkingText(block) {
    if (typeof block?.thinking === 'string') return block.thinking;
    if (!Array.isArray(block?.thinking)) return '';
    return block.thinking
        .map(t => (typeof t === 'string' ? t : (t?.type === 'text' || t?.type === undefined ? (t?.text || '') : '')))
        .join('');
}

/** A tool definition in the shape v2 requires: `type: 'function'` explicit. */
function toSdkTool(tool) {
    if (tool && tool.function && !tool.type) return { type: 'function', ...tool };
    return tool;
}

class MistralProvider extends BaseProvider {
    constructor() {
        super('mistral');
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(apiKey, baseUrl) {
        const { Mistral } = require('@mistralai/mistralai');
        warnIfSdkTelemetryEnabled();
        const serverURL = resolveServerUrl(baseUrl);
        return new Mistral({
            apiKey,
            ...(serverURL ? { serverURL } : {}),
            // No SDK timeout: the adapter owns it (see _requestOptions). -1 is
            // the SDK's "none"; its own default would cut a stream at 300 s.
            timeoutMs: -1,
            // Explicit, though it is also the SDK default: retries belong to
            // the stack's retry layer, which knows whether output was emitted.
            retryConfig: { strategy: 'none' },
        });
    }

    // ─── Capabilities ────────────────────────────────────────────

    supportsVision(modelId) {
        return describeMistralModel(modelId).vision;
    }

    supportsReasoning(modelId) {
        return describeMistralModel(modelId).reasoning;
    }

    /**
     * Mistral's thinking chunks are the model's own chain of thought, not a
     * summary written by the provider — so the tier's Reasoning Summary
     * switch can only be honoured here (base `_wantsThinking`), exactly as on
     * a self-hosted runtime. It also tells the builders the unsigned thinking
     * parts are worth keeping, which is what makes the replay possible there.
     */
    surfacesRawReasoning() {
        return true;
    }

    /**
     * Map the normalized cross-provider tool_choice to Mistral's vocabulary.
     * Mistral's own word for "must call a tool" is 'any'; our stack emits
     * 'required' (OpenAI's word). v2 accepts both, but 'any' is the one
     * Mistral documents. Everything else passes through, including the
     * `{ type: 'function', function: { name } }` object llmClient forces.
     */
    mapToolChoice(toolChoice) {
        if (!toolChoice) return 'auto';
        if (toolChoice === 'required') return 'any';
        return toolChoice;
    }

    // ─── Request building ────────────────────────────────────────

    /**
     * Messages in the SDK's shape.
     *
     * - Internal companion fields (thinking parts, sidecars) come off — but the
     *   thinking is read first, for the replay below.
     * - `tool_calls` → `toolCalls`, `tool_call_id` → `toolCallId`, with every id
     *   mapped through toMistralToolCallId and `arguments` always a string.
     * - OpenAI-style `image_url: { url }` → `imageUrl: <string>`.
     * - An assistant message never has null content (Mistral rejects it).
     * - With reasoning on, an assistant message after the last user message
     *   gets its own thinking back in front of its content. Mistral's docs ask
     *   for the full assistant message, thinking included; before the last
     *   user message it is stale, and the same boundary local.js uses.
     *
     * @param {Array} messages
     * @param {{ replayThinking?: boolean }} [opts]
     */
    normalizeMessages(messages, { replayThinking = false } = {}) {
        if (!Array.isArray(messages)) return [];
        let lastUser = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'user') { lastUser = i; break; }
        }

        return stripInternalFields(messages).map((msg, idx) => {
            if (!msg || typeof msg !== 'object') return msg;
            const normalized = { ...msg };

            if (Array.isArray(normalized.content)) {
                normalized.content = normalized.content.map(block => {
                    if (block && block.type === 'image_url' && block.image_url !== undefined) {
                        const url = typeof block.image_url === 'string' ? block.image_url : (block.image_url?.url || '');
                        return { type: 'image_url', imageUrl: url };
                    }
                    return block;
                });
            }

            if (normalized.role === 'assistant') {
                const calls = normalized.toolCalls || normalized.tool_calls;
                delete normalized.tool_calls;
                if (Array.isArray(calls) && calls.length > 0) {
                    normalized.toolCalls = calls.map((tc, i) => {
                        const fn = tc?.function || {};
                        return {
                            id: toMistralToolCallId(realId(tc?.id) || `missing-${idx}-${i}`),
                            type: 'function',
                            function: {
                                name: fn.name || tc?.name || '',
                                arguments: argumentsString(fn.arguments ?? tc?.input ?? tc?.arguments),
                            },
                            index: i,
                        };
                    });
                } else {
                    delete normalized.toolCalls;
                }
                if (normalized.content === null || normalized.content === undefined) {
                    normalized.content = '';
                }
                if (replayThinking && idx > lastUser) {
                    const text = replayableThinking(messages[idx]);
                    if (text) {
                        const rest = typeof normalized.content === 'string'
                            ? (normalized.content ? [{ type: 'text', text: normalized.content }] : [])
                            : normalized.content;
                        normalized.content = [{ type: 'thinking', thinking: [{ type: 'text', text }] }, ...rest];
                    }
                }
            }

            if (normalized.role === 'tool') {
                const id = realId(normalized.toolCallId) || realId(normalized.tool_call_id);
                delete normalized.tool_call_id;
                normalized.toolCallId = toMistralToolCallId(id || `missing-${idx}`);
            }

            return normalized;
        });
    }

    /**
     * The SDK request for one call. Every key is an SDK name (see the header).
     * @param {string} model
     * @param {Array} messages
     * @param {object} options
     * @param {{ stream?: boolean }} [mode]
     */
    buildParams(model, messages, options = {}, { stream = false } = {}) {
        // Nothing asked means reasoning off, sent explicitly. Not every path
        // resolves a tier default (direct chat's fast tier arrives as
        // undefined), and leaving it to the model's own default would make
        // the fast tier's latency depend on a value Mistral can change.
        // Reasoning happens when a tier asks for it — thinking, deep_thinking.
        const effort = normalizeMistralEffort(model, options.reasoningEffort || 'none');
        const reasoningOn = !!effort && effort !== 'none';

        let maxTokens = options.maxTokens ?? options.max_tokens ?? DEFAULT_MAX_TOKENS;
        if (reasoningOn && maxTokens < REASONING_MIN_MAX_TOKENS) maxTokens = REASONING_MIN_MAX_TOKENS;

        /** @type {Record<string, any>} */
        const params = {
            model,
            messages: this.normalizeMessages(messages, { replayThinking: reasoningOn }),
            maxTokens,
        };
        if (stream) params.stream = true;
        if (options.temperature !== undefined) params.temperature = options.temperature;
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools.map(toSdkTool);
            params.toolChoice = this.mapToolChoice(options.toolChoice);
        }
        if (effort) params.reasoningEffort = effort;
        const cacheKey = conversationCacheKey(options.promptCacheKey);
        if (cacheKey) params.promptCacheKey = cacheKey;
        // Last, as everywhere: an explicit override wins. Only keys the SDK
        // schema knows survive, in camelCase.
        if (options.extraBody) Object.assign(params, options.extraBody);
        return params;
    }

    /**
     * Per-call SDK options. A signal is always passed when there is anything
     * to abort on; the SDK ignores its own timeout when it gets one.
     */
    _requestOptions(signal, options = {}) {
        return {
            ...(signal ? { signal } : {}),
            ...(options.retries !== undefined ? { retries: options.retries } : {}),
        };
    }

    // ─── Response parsing ────────────────────────────────────────

    /**
     * Split Mistral content into thinking and text.
     *
     * A reasoning turn returns an array of typed chunks:
     *   [{ type: 'thinking', thinking: [{ type: 'text', text }] }, { type: 'text', text }]
     * A plain turn returns a string. Chunks the SDK does not know come back as
     * `{ type: 'UNKNOWN', raw }` and are never rendered as text.
     */
    parseContentBlocks(content) {
        if (typeof content === 'string') return { thinking: null, text: content };
        if (!Array.isArray(content)) return { thinking: null, text: content == null ? '' : String(content) };

        let thinking = '';
        let text = '';
        for (const block of content) {
            if (typeof block === 'string') text += block;
            else if (block?.type === 'thinking') thinking += thinkingText(block);
            else if (block?.type === 'text') text += block.text || '';
            else log.debug(`[Mistral] Ignoring content chunk of type ${block?.type}`);
        }
        return { thinking: thinking || null, text };
    }

    _parseResponse(response, options = {}) {
        const choice = response?.choices?.[0];
        const message = choice?.message;
        const { thinking, text } = this.parseContentBlocks(message?.content);
        const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
        const toolCalls = calls.length === 0 ? null : calls.map((tc, i) => ({
            id: realId(tc.id) || toMistralToolCallId(`response-${i}-${tc.function?.name || ''}`),
            type: 'function',
            function: { name: tc.function?.name || '', arguments: argumentsString(tc.function?.arguments) },
        }));
        const stopReason = toStopReason(choice?.finishReason);
        return {
            content: text || null,
            // Split off content either way; the switch only decides whether
            // it is handed back.
            ...(thinking && this._wantsThinking(options) ? { thinking } : {}),
            toolCalls,
            usage: toSnakeUsage(response?.usage),
            ...(stopReason ? { stop_reason: stopReason } : {}),
            raw: response,
        };
    }

    // ─── Errors ──────────────────────────────────────────────────

    /**
     * One error shape for both paths.
     *
     *  - The caller aborted: rethrow the caller's own reason, so it reads as a
     *    cancel and not as a provider failure.
     *  - Our timeout or watchdog fired: its message (it says what happened).
     *  - An HTTP error: `mistral API error <status>: <body>` with `.status`,
     *    the form streamRetry/toolLoop parse — the SDK's own message
     *    ("API error occurred: Status 429") matched neither, so a 429 or a 5xx
     *    was never retried.
     *
     * @param {any} err
     * @param {string} model
     * @param {{ callerSignal?: AbortSignal, ownSignal?: AbortSignal }} [signals]
     */
    _normalizeError(err, model, { callerSignal, ownSignal } = {}) {
        if (callerSignal?.aborted) return callerSignal.reason ?? err;
        if (ownSignal?.aborted) return ownSignal.reason instanceof Error ? ownSignal.reason : err;
        const status = Number(err?.statusCode ?? err?.status);
        if (Number.isInteger(status) && status >= 400) {
            this._recordHttpError(model, status);
            const body = typeof err.body === 'string' && err.body ? err.body : (err.message || '');
            /** @type {Error & { status?: number, cause?: unknown }} */
            const wrapped = new Error(`${this.name} API error ${status}: ${body}`);
            wrapped.status = status;
            wrapped.cause = err;
            return wrapped;
        }
        return err;
    }

    // ─── High-level API ──────────────────────────────────────────

    /**
     * Non-streaming chat.
     * @returns {Promise<{content: string|null, toolCalls: Array|null, usage: object|null,
     *   thinking?: string, stop_reason?: string, raw: object}>}
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const client = this.createClient(apiKey, baseUrl);
        // Our own storage URLs must become bytes first: Mistral cannot fetch
        // them (signed, internal), and an unreachable image fails the request.
        const { inlineInternalImages } = require('../documents/imageInline');
        const params = this.buildParams(model, await inlineInternalImages(messages), options);

        const timeout = this._requestTimeout(options.timeoutMs);
        const signal = this._combineSignals(timeout.controller?.signal, options.signal);

        log.info('[Mistral] SDK chat for model:', model, params.reasoningEffort ? `(effort ${params.reasoningEffort})` : '');
        try {
            const response = await client.chat.complete(/** @type {any} */ (params), this._requestOptions(signal, options));
            return this._parseResponse(response, options);
        } catch (err) {
            throw this._normalizeError(err, model, { callerSignal: options.signal, ownSignal: timeout.controller?.signal });
        } finally {
            timeout.clear();
        }
    }

    /**
     * Streaming chat. Events: text, thinking_start/thinking/thinking_stop,
     * tool_args_delta, tool_use, tool_use_invalid, error, done.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey, baseUrl);
        const { inlineInternalImages } = require('../documents/imageInline');
        const params = this.buildParams(model, await inlineInternalImages(messages), options, { stream: true });

        // Stall watchdog: re-armed on every event, so a slow-but-alive
        // reasoning stream is never cut off while a wedged one is.
        const watchdog = this._stallWatchdog(options.timeoutMs);
        const { arm } = watchdog;
        const signal = this._combineSignals(watchdog.controller?.signal, options.signal);

        const { accumulateToolCalls, flushToolCalls, emitThinking, closeThinking } =
            this._createStreamEmitter(onEvent, options, THINKING_PART_ID);
        const slotFor = createToolCallSlotter();
        let usage = null;
        let stopReason = null;

        log.info('[Mistral] SDK streaming for model:', model, params.reasoningEffort ? `(effort ${params.reasoningEffort})` : '');
        try {
            const stream = await client.chat.stream(/** @type {any} */ (params), this._requestOptions(signal, options));
            for await (const event of stream) {
                arm();
                const data = event?.data;
                if (!data) continue;
                if (data.usage) usage = toSnakeUsage(data.usage);

                const choice = data.choices?.[0];
                const finishReason = choice?.finishReason;
                if (finishReason) stopReason = toStopReason(finishReason);

                const delta = choice?.delta;
                if (delta?.content !== undefined && delta?.content !== null) {
                    if (typeof delta.content === 'string') {
                        if (delta.content) { closeThinking(); onEvent('text', { text: delta.content }); }
                    } else if (Array.isArray(delta.content)) {
                        for (const block of delta.content) {
                            if (typeof block === 'string') {
                                if (block) { closeThinking(); onEvent('text', { text: block }); }
                            } else if (block?.type === 'thinking') {
                                emitThinking(thinkingText(block));
                            } else if (block?.type === 'text') {
                                if (block.text) { closeThinking(); onEvent('text', { text: block.text }); }
                            } else {
                                log.debug(`[Mistral] Ignoring stream chunk of type ${block?.type}`);
                            }
                        }
                    }
                }

                if (Array.isArray(delta?.toolCalls) && delta.toolCalls.length > 0) {
                    closeThinking();
                    accumulateToolCalls(delta.toolCalls.map(tc => ({
                        index: slotFor(tc),
                        id: realId(tc.id),
                        function: { name: tc.function?.name, arguments: argumentsString(tc.function?.arguments) },
                    })));
                }

                if (finishReason === 'tool_calls' || finishReason === 'stop') flushToolCalls();
            }
        } catch (err) {
            throw this._normalizeError(err, model, { callerSignal: options.signal, ownSignal: watchdog.controller?.signal });
        } finally {
            watchdog.clear();
        }

        // Backstop: a stream that ended without a finish reason still hands
        // over what it accumulated.
        closeThinking();
        flushToolCalls();
        if (stopReason === 'error') onEvent('error', { error: 'Mistral ended the response with an error' });
        onEvent('done', { ...(usage || {}), ...(stopReason ? { stop_reason: stopReason } : {}) });
    }

    /**
     * The models this key can use, with what the API says about each.
     *
     * `/v1/models` carries capability flags, so they are passed on (the tier
     * picker filters and labels on them) and remembered for the capability
     * checks above. Aliases are listed as ids of their own: an admin who
     * picked `mistral-small-latest` must find it here, or model routing
     * (modelCache.getProviderForModel) reports it as served by no provider.
     * A failed call returns nothing — a provider whose key is invalid must not
     * appear to serve anything.
     */
    async listModels(apiKey, baseUrl) {
        let response;
        try {
            response = await this.createClient(apiKey, baseUrl).models.list();
        } catch (e) {
            log.error('[Mistral] SDK listModels failed:', e.message);
            return [];
        }

        const seen = new Set();
        const out = [];
        // A card type this SDK version does not know comes back as
        // `{ type: 'UNKNOWN', raw }` without an id and is skipped.
        for (const card of /** @type {Array<any>} */ (response?.data || [])) {
            if (!card?.id) continue;
            // Flagged, not dropped: a model with a deprecation date still
            // answers until Mistral removes it, and removed models are no
            // longer listed at all.
            const deprecated = !!card.deprecation;

            const caps = card.capabilities || {};
            const live = {
                vision: !!caps.vision,
                tools: !!caps.functionCalling,
                reasoning: !!caps.reasoning,
                ...(card.maxContextLength ? { context: card.maxContextLength } : {}),
            };
            for (const id of [card.id, ...(card.aliases || [])]) {
                if (!id || seen.has(id)) continue;
                seen.add(id);
                rememberMistralCapabilities(id, live);
                const described = describeMistralModel(id);
                out.push({
                    id,
                    name: described.name === id ? (card.name || id) : described.name,
                    cat: categoryFor(caps, described.cat),
                    vision: described.vision,
                    tools: described.tools,
                    reasoning: described.reasoning,
                    ...(described.efforts ? { efforts: [...described.efforts] } : {}),
                    ...(described.context ? { contextWindow: described.context } : {}),
                    ...(deprecated ? { deprecated: true } : {}),
                });
            }
        }
        return out;
    }
}

/**
 * Tier-picker category from the API's own flags. A card that cannot chat is
 * whatever it CAN do — the picker drops Embedding/OCR/Moderation/Audio.
 */
function categoryFor(caps, fallback) {
    if (caps.completionChat === false) {
        if (caps.ocr) return 'OCR';
        if (caps.moderation || caps.classification) return 'Moderation';
        if (caps.audioTranscription || caps.audioSpeech || caps.audioTranscriptionRealtime) return 'Audio';
        return fallback === 'Generalist' ? 'Embedding' : fallback;
    }
    return fallback;
}

/**
 * Stream slot per tool call. The SDK defaults a missing `index` to 0, so two
 * parallel calls that arrive without one would land in the same slot and
 * concatenate into invalid JSON. A call with a real id is its own slot; a
 * fragment without one continues the call in flight.
 */
function createToolCallSlotter() {
    const byId = new Map();
    let last = -1;
    return (tc) => {
        const id = realId(tc?.id);
        if (id) {
            if (!byId.has(id)) byId.set(id, byId.size);
            last = byId.get(id);
            return last;
        }
        if (last < 0) last = byId.size;
        return last;
    };
}

/**
 * The thinking an assistant message carries that may be sent back: text
 * parts only. Signed and redacted parts are Anthropic's and never replayed.
 */
function replayableThinking(message) {
    if (!message || !Array.isArray(message.thinking)) return '';
    return message.thinking
        .filter(p => p && typeof p.text === 'string' && p.text && !p.signature && !p.redacted)
        .map(p => p.text)
        .join('\n');
}

let telemetryWarned = false;
/**
 * The SDK can export request traces — to api.mistral.ai itself in
 * 'dedicated' mode — when MISTRAL_SDK_TELEMETRY is set. It is off unless that
 * variable is set, and nothing here sets it; an operator who does gets told
 * once, loudly, because this is a privacy product.
 */
function warnIfSdkTelemetryEnabled() {
    if (telemetryWarned) return;
    const value = String(process.env.MISTRAL_SDK_TELEMETRY || '').trim().toLowerCase();
    if (!value || value === 'false') return;
    telemetryWarned = true;
    log.warn(`[Mistral] MISTRAL_SDK_TELEMETRY=${value}: the Mistral SDK will export request traces${value === 'dedicated' ? ' to Mistral' : ''}. Unset it unless that is intended.`);
}

MistralProvider.toMistralToolCallId = toMistralToolCallId;
MistralProvider.toSnakeUsage = toSnakeUsage;
MistralProvider.resolveServerUrl = resolveServerUrl;

module.exports = MistralProvider;
