// @typecheck
/**
 * OpenAI Provider Adapter
 *
 * 100% SDK-based — uses the official `openai` package for ALL API calls.
 * No raw fetch, no manual SSE parsing.
 *
 * Supports:
 * - Responses API (the default — better prompt-cache reuse, reasoning
 *   summaries, and the only endpoint that carries tool calls on gpt-6)
 * - Chat Completions API (explicit opt-out, and the Azure subclass's fallback)
 * - Streaming via SDK typed events
 * - Tool calling, including strict schemas and parallel calls
 * - Native structured outputs (json_schema)
 * - Model listing
 *
 * Per-model facts (effort vocabularies, temperature support, context windows,
 * prompt-cache parameters) come from ./openaiModels.js — see the note at the
 * top of that file for why they are data rather than regexes.
 */

const BaseProvider = require('./base');
const { stripInternalFields, coerceWireContent } = require("../../utils/messageUtils");
const { inlineInternalImages } = require('../documents/imageInline');
const { toResponsesPart, toCompletionsContent } = require('./openaiContent');
const { describeOpenAIModel, OPENAI_BASE_URL, OPENAI_EU_BASE_URL, isEuResidencyUrl } = require('./openaiModels');
const {
    clampEffort,
    buildReasoningParams,
    supportsVerbosity,
    supportsTemperature,
    supportsParallelToolCalls,
    requiresResponsesApi,
    cacheTtlParams,
    mapToolChoice,
    mapResponsesToolChoice,
    qualifiesForStrict,
} = require('./openaiModelCaps');
const log = require('../../telemetry/log');
const { normalizeUsage } = require('./usageNormalizer');

class OpenAIProvider extends BaseProvider {
    constructor() {
        super('openai');
        // OpenAI uses server-side response storage so we can chain turns via
        // previous_response_id. Azure overrides this to false (see azure.js).
        this.responsesStore = true;
    }

    // ─── SDK Client ──────────────────────────────────────────────

    /**
     * @param {string} apiKey
     * @param {object} [options]
     * @param {string} [options.baseUrl] - custom endpoint. Used for proxies and
     *   for EU regional processing (https://eu.api.openai.com/v1). Previously
     *   ignored, which silently sent EU-configured traffic to the US endpoint.
     * @param {boolean} [options.euResidency] - force the EU endpoint even when
     *   the provider record still carries the default URL.
     */
    createClient(apiKey, options = {}) {
        // The CJS build exports the class itself; the .d.ts only declares it as `default`.
        const OpenAI = /** @type {typeof import('openai').default} */ (/** @type {unknown} */ (require('openai')));
        // openai-node v5+ uses the platform's native fetch (undici on Node 18+),
        // which terminates SSE streams cleanly — no node-fetch v2
        // ERR_STREAM_PREMATURE_CLOSE workaround needed.
        let baseURL = options.baseUrl || OPENAI_BASE_URL;
        if (options.euResidency && !isEuResidencyUrl(baseURL)) baseURL = OPENAI_EU_BASE_URL;
        if (isEuResidencyUrl(baseURL)) {
            log.info(`[${this.name}] EU regional processing — inference stays in the EU`);
        }
        return new OpenAI({ apiKey, baseURL });
    }

    // ─── Model Helpers ───────────────────────────────────────────

    isRestrictedModel(modelId) {
        return !supportsTemperature(modelId);
    }

    supportsReasoning(modelId) {
        return describeOpenAIModel(modelId).reasoning;
    }

    supportsVision(modelId) {
        return describeOpenAIModel(modelId).vision;
    }

    /**
     * Native PDF input: a `document` part goes out as a Responses `input_file`
     * (openaiContent.js), and the model gets the extracted text plus an image
     * of every page, so it needs vision. Only on the Responses API: an Azure
     * deployment that fell back to Chat Completions (`_completionsOnly`) is
     * answered no, because Azure documents PDF input for Responses only.
     * `this.` calls, so Azure's deployment → model mapping applies.
     */
    supportsDocuments(modelId) {
        return !!this.supportsVision(modelId) && !!this.shouldUseResponsesApi(modelId);
    }

    supportsStructuredOutput(modelId, schema) {
        // No schema to check: the caller only wants to know whether the
        // parameter exists at all, and it does.
        if (schema === undefined) return true;
        return qualifiesForStrict(schema);
    }

    /**
     * The Responses API is OpenAI's recommended default and reuses the prompt
     * cache far better than Chat Completions on multi-turn conversations, so it
     * is what we send unless a caller explicitly opts out. gpt-6 additionally
     * REFUSES tool calls on Chat Completions, so for that model this is not a
     * preference but a requirement — `requiresResponsesApi` overrides an opt-out.
     */
    shouldUseResponsesApi(model, options = {}) {
        if (requiresResponsesApi(model, options)) return true;
        if (options.useChatCompletions) return false;
        return true;
    }

    /**
     * Attach cache-routing + abuse-monitoring hints to a request.
     * `prompt_cache_key` is the dedicated cache-routing hint (better hit rate
     * than overloading `user`); `user` is retained for abuse monitoring. The
     * TTL parameter differs per model generation — see cacheTtlParams.
     * Shared across Chat Completions and Responses, OpenAI and Azure.
     */
    _applyCacheHints(params, options = {}, model = null) {
        if (options.promptCacheKey) params.prompt_cache_key = String(options.promptCacheKey);
        if (options.userId) params.user = String(options.userId);
        if (model && this.supportsPromptCacheTtl()) {
            Object.assign(params, cacheTtlParams(model, options));
        }
    }

    /**
     * Does this endpoint accept the prompt-cache TTL parameters?
     *
     * True on OpenAI proper. Azure exposes a narrower, version-pinned surface
     * and answers an unknown parameter with a 400 that fails the whole request,
     * so the subclass turns this off — it sent neither parameter before, and
     * caching still works there without them.
     */
    supportsPromptCacheTtl() {
        return true;
    }

    /**
     * Does this model accept an explicit `prompt_cache_breakpoint`?
     *
     * Same generation boundary as the TTL parameter: it arrived with the models
     * that take `prompt_cache_options`. Anything older rejects it with a 400
     * that kills the request, so this is checked, never assumed.
     */
    supportsCacheBreakpoint(model) {
        const { CACHE_TTL_OPTIONS } = require('./openaiModels');
        return this.supportsPromptCacheTtl()
            && describeOpenAIModel(model).cacheTtlParam === CACHE_TTL_OPTIONS;
    }

    /**
     * Convert our internal OpenAI-Chat-shaped tool definitions to the Responses
     * API's flat shape, and mark the ones whose schema is strict-safe.
     *
     * `strict` is worth having: it is what makes a tool call reliably match its
     * schema. But it rides on structured outputs, which rejects any object that
     * is not fully closed and fully required — so a blanket `strict: true`
     * would turn working tool calls into 400s. qualifiesForStrict checks first.
     */
    _applyResponsesToolParams(params, options, effort) {
        if (!options.tools || options.tools.length === 0) return;

        params.tools = options.tools.map(t => {
            const parameters = t.function?.parameters || t.parameters || {};
            const tool = {
                type: 'function',
                name: t.function?.name || t.name,
                description: t.function?.description || t.description || '',
                parameters,
            };
            // Always explicit. `strict` is a required field on the Responses
            // FunctionTool type and the API attempts strict mode by default, so
            // leaving it off a schema that cannot satisfy structured outputs
            // invites a rejection — say false rather than stay silent.
            const wantsStrict = t.function?.strict ?? t.strict;
            tool.strict = wantsStrict !== false && qualifiesForStrict(parameters);
            return tool;
        });

        // Responses spells a forced function flat (`{type:'function', name}`),
        // not wrapped the way Chat Completions does — see mapResponsesToolChoice.
        const tc = mapResponsesToolChoice(options.toolChoice);
        if (tc) params.tool_choice = tc;
        if (!supportsParallelToolCalls(effort)) params.parallel_tool_calls = false;
    }

    /**
     * Native structured output. Responses puts the schema under `text.format`;
     * Chat Completions keeps the older `response_format` envelope.
     * Returns the value to assign, or null when nothing was requested.
     */
    _structuredOutputFormat(options = {}) {
        const rf = options.responseFormat || options.responseSchema;
        if (!rf) return null;

        // Already in Chat Completions' {type:'json_schema', json_schema:{…}} shape.
        if (rf.type === 'json_schema' && rf.json_schema) {
            const js = rf.json_schema;
            return {
                type: 'json_schema',
                name: js.name || 'response',
                schema: js.schema,
                strict: js.strict !== false && qualifiesForStrict(js.schema),
            };
        }
        if (rf.type === 'json_object' || rf.type === 'text') return { type: rf.type };
        // A bare JSON Schema.
        if (rf.schema || rf.properties) {
            const schema = rf.schema || rf;
            return {
                type: 'json_schema',
                name: rf.name || 'response',
                schema,
                strict: rf.strict !== false && qualifiesForStrict(schema),
            };
        }
        return null;
    }

    /**
     * Normalise a usage object into the shape the rest of the platform records
     * (usageStore, modelCosts, the dashboards). Both APIs and both the
     * streaming and non-streaming paths go through here — they used to
     * normalise in four places, and the non-streaming ones didn't, which is why
     * several call sites read `usage.prompt_tokens_details?.cached_tokens ||
     * usage.cached_tokens` defensively.
     */
    _normalizeUsage(usage, meta) {
        // `meta.service_tier` is the response's own `service_tier` (the tier
        // OpenAI actually billed: default/flex/priority/...); it lives on the
        // response, not in the usage block.
        return normalizeUsage('openai', usage, meta);
    }

    _logUsage(usage, label) {
        if (!usage) return;
        if (usage.cached_tokens > 0) {
            log.info(`[${this.name}] ⚡ ${label} cache hit: ${usage.cached_tokens} cached tokens`);
        }
        if (usage.reasoning_tokens > 0) {
            log.info(`[${this.name}] 🧠 ${label} reasoning: ${usage.reasoning_tokens} tokens (of ${usage.completion_tokens} output)`);
        }
    }

    // ─── Responses API input normalization ────────────────────────

    toResponsesInput(messages, options = {}) {
        const result = [];
        // Remap call_* IDs to fc_* IDs (Responses API requires fc_ prefix)
        const idMap = {};
        const remapId = (id) => {
            if (!id) return id;
            if (id.startsWith('fc_')) return id;
            if (!idMap[id]) {
                idMap[id] = 'fc_' + id.replace(/^call_/, '');
            }
            return idMap[id];
        };

        // Explicit cache breakpoint. The prefix that is genuinely stable across
        // turns is the leading developer/system block; everything after it grows
        // every round, so pinning the boundary there beats letting it land
        // wherever the conversation happens to end.
        //
        // Two hard-won details. It belongs on the input CONTENT object, not on
        // the input item — at item level the API answers
        // `400 Unknown parameter: 'input[1].prompt_cache_breakpoint'` and the
        // whole turn fails. And it only exists on the generation that takes
        // `prompt_cache_options`; older models reject it outright. So it is
        // OPT-IN (`cacheBreakpoint: true`) and gated on the model, rather than
        // on by default: automatic prefix caching works without it, and a
        // rejected parameter costs the user their entire message.
        let breakpointPending = options.cacheBreakpoint === true;
        const markBreakpoint = (content) => {
            if (!breakpointPending || !Array.isArray(content) || content.length === 0) return;
            breakpointPending = false;
            content[content.length - 1].prompt_cache_breakpoint = { mode: 'explicit' };
        };

        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];

            // Tool result messages → function_call_output items
            if (m.role === 'tool') {
                result.push({
                    type: 'function_call_output',
                    call_id: remapId(m.tool_call_id),
                    output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
                });
                continue;
            }

            // Responses API uses 'developer' role instead of 'system'
            const role = m.role === 'system' ? 'developer' : m.role;

            // Convert content to Responses API format. A plain object here (an
            // old history row revived by JSON.parse) would otherwise reach the
            // wire as-is and 400 every later turn; direct chat never runs
            // sanitizeMessages, so this is its only guard.
            let content = coerceWireContent(m.content, m.role);

            // Handle null/undefined content (e.g. assistant messages with only tool calls)
            if (content === null || content === undefined) {
                content = '';
            }

            if (Array.isArray(content)) {
                // Every part is rebuilt for the Responses API (see openaiContent.js):
                // a part forwarded as-is 400s the whole turn.
                content = content.map(part => toResponsesPart(part, role)).filter(Boolean);
                if (content.length === 0) content = '';
            } else if (typeof content === 'string' && (role === 'user' || (role === 'developer' && breakpointPending))) {
                content = [{ type: 'input_text', text: content }];
            }

            // Close the cacheable prefix after the last leading developer
            // message — that is the system prompt, and it is what repeats.
            if (role === 'developer' && messages[i + 1]?.role !== 'system') markBreakpoint(content);
            result.push({ role, content });

            // Replay the model's own reasoning items before the tool calls they
            // led to. With server-side storage OpenAI does this for us via
            // previous_response_id, but in stateless mode (Azure, and any
            // zero-retention deployment) the reasoning context is simply lost
            // between rounds unless we send it back — the same problem, and the
            // same fix, as replaying Claude's thinking blocks.
            if (m.role === 'assistant' && Array.isArray(m.reasoningItems)) {
                for (const ri of m.reasoningItems) {
                    if (ri?.encrypted_content) result.push(ri);
                }
            }

            // If assistant message had tool_calls, emit function_call items after it
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    const mappedId = remapId(tc.id);
                    result.push({
                        type: 'function_call',
                        id: mappedId,
                        call_id: mappedId,
                        name: tc.function?.name || tc.name,
                        arguments: tc.function?.arguments || JSON.stringify(tc.input || {}),
                    });
                }
            }
        }
        return result;
    }

    /** Shared Responses request body for both the streaming and non-streaming paths. */
    _buildResponsesParams(model, messages, options = {}) {
        const params = { model, store: this.responsesStore };

        // Chain from a prior response only when storage is enabled (chaining
        // requires server-side state). Azure runs store:false → always full history.
        if (this.responsesStore && options.previousResponseId) {
            params.previous_response_id = options.previousResponseId;
            // Send everything from the last user message onward — the new turn
            // AND any tool results that followed it. Sending only the user
            // message drops the tool output the model is waiting for.
            const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
            const newMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
            // A chained request carries no stable prefix of its own — the cached
            // prefix lives in the stored response.
            params.input = this.toResponsesInput(newMessages, { cacheBreakpoint: false });
        } else {
            params.input = this.toResponsesInput(messages, {
                ...options,
                cacheBreakpoint: options.cacheBreakpoint === true && this.supportsCacheBreakpoint(model),
            });
        }

        if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;
        // Note: the Responses API takes no temperature on reasoning models, and
        // the current generation refuses it outright — see openaiModels.js.
        if (options.temperature !== undefined && supportsTemperature(model)) {
            params.temperature = options.temperature;
        }

        const reasoning = buildReasoningParams(model, options);
        if (reasoning) params.reasoning = reasoning;
        const effort = reasoning?.effort || null;

        const text = {};
        if (options.verbosity && supportsVerbosity(model)) text.verbosity = options.verbosity;
        const format = this._structuredOutputFormat(options);
        if (format) text.format = format;
        if (Object.keys(text).length) params.text = text;

        // Stateless mode returns the encrypted reasoning blocks in the response
        // by default, so there is nothing to ask for — `include:
        // ['reasoning.encrypted_content']` is legacy and no longer required.
        // We don't send it: an unrecognised include value is a 400, and we gain
        // nothing. toResponsesInput replays whatever the caller kept.

        this._applyResponsesToolParams(params, options, effort);
        this._applyCacheHints(params, options, model);
        if (options.extraBody) Object.assign(params, options.extraBody);
        return params;
    }

    /** Shared Chat Completions request body. */
    _buildCompletionsParams(model, messages, options = {}) {
        // messages go to the SDK verbatim, so the internal companion fields the
        // chat runtimes carry (thinking parts, attachment sidecars, …) have to
        // come off here — OpenAI rejects unknown message properties.
        const params = {
            model,
            messages: stripInternalFields(messages).map(m => {
                const content = toCompletionsContent(m.content, m.role);
                return content === m.content ? m : { ...m, content };
            }),
        };

        if (options.maxTokens !== undefined) params.max_completion_tokens = options.maxTokens;
        if (options.temperature !== undefined && !this.isRestrictedModel(model)) {
            params.temperature = options.temperature;
        }
        if (options.tools && options.tools.length > 0) {
            params.tools = options.tools;
            params.tool_choice = mapToolChoice(options.toolChoice) || 'auto';
        }
        const effort = clampEffort(model, options.reasoningEffort);
        if (effort && effort !== 'none' && this.supportsReasoning(model)) {
            params.reasoning_effort = effort;
        }
        // GPT-5 output-length control (low/medium/high). Only sent for models
        // that support it so gpt-4o/o-series requests stay untouched.
        if (options.verbosity && supportsVerbosity(model)) params.verbosity = options.verbosity;

        const format = this._structuredOutputFormat(options);
        if (format) {
            params.response_format = format.type === 'json_schema'
                ? { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, strict: format.strict } }
                : format;
        }

        this._applyCacheHints(params, options, model);
        if (options.extraBody) Object.assign(params, options.extraBody);
        return params;
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Images we host ourselves are referenced by a short-lived signed URL on our
     * own origin. OpenAI and Azure cannot fetch that (self-hosted installs are
     * not reachable, and a fresh signature every turn busts the prompt cache),
     * so the bytes go inline — the same step the Claude, Gemini and Mistral
     * adapters take. External URLs a user pasted are left for the provider.
     */
    async _prepareMessages(messages) {
        return inlineInternalImages(messages);
    }

    /**
     * Non-streaming chat via SDK.
     * Responses API by default; Chat Completions on explicit opt-out.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const client = this.createClient(apiKey, { ...options, baseUrl });
        messages = await this._prepareMessages(messages);

        if (this.shouldUseResponsesApi(model, options)) {
            return this._chatResponses(client, model, messages, options);
        }
        return this._chatCompletions(client, model, messages, options);
    }

    async _chatCompletions(client, model, messages, options = {}) {
        const params = this._buildCompletionsParams(model, messages, options);

        log.info(`[${this.name}] SDK chat (completions) for model:`, model);
        const response = await client.chat.completions.create(params);

        const message = response.choices?.[0]?.message;
        const usage = this._normalizeUsage(response.usage, { service_tier: response.service_tier });
        this._logUsage(usage, 'Completions');
        // A refusal carries no content, so returning null reads downstream as
        // "the model had nothing to say" rather than "the model declined" —
        // same reasoning as Claude's refusal placeholder (claude.js chat()).
        const content = message?.content || message?.refusal || null;
        return {
            content,
            toolCalls: message?.tool_calls || null,
            stopReason: response.choices?.[0]?.finish_reason || null,
            usage,
            raw: response,
        };
    }

    async _chatResponses(client, model, messages, options = {}) {
        const params = this._buildResponsesParams(model, messages, options);

        log.info(`[${this.name}] SDK chat (responses, store=${this.responsesStore}) for model:`, model);
        const response = await client.responses.create(params);

        // The Responses API reports failure OUT of band: a 200 response whose
        // `status` is 'failed' or 'incomplete', with empty/partial output.
        // Returning that as content:null reads downstream as "the model had
        // nothing to say" and the conversation silently stops — throw instead,
        // so callers' normal error handling surfaces what actually happened.
        if (response.status === 'failed') {
            throw new Error(`OpenAI response failed: ${response.error?.message || 'unknown error'}`);
        }

        // Extract any function_call items from the Responses output and map them
        // to the OpenAI Chat Completions tool_calls shape callers expect.
        const output = response.output || [];
        const toolCalls = output
            .filter(item => item?.type === 'function_call')
            .map(item => ({
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name, arguments: item.arguments || '{}' },
            }));

        const incompleteReason = response.status === 'incomplete'
            ? (response.incomplete_details?.reason || 'incomplete')
            : null;
        if (incompleteReason && !response.output_text && toolCalls.length === 0) {
            // Nothing usable came back — most often reasoning tokens ate the
            // whole max_output_tokens budget on a reasoning-tier model.
            const err = /** @type {Error & { stopReason?: string }} */ (new Error(`OpenAI response incomplete (${incompleteReason}): the model produced no output`));
            err.stopReason = incompleteReason;
            throw err;
        }
        if (incompleteReason) {
            log.warn(`[${this.name}] Responses incomplete (${incompleteReason}) — returning partial output`);
        }

        // Encrypted reasoning blocks, for stateless replay on the next round.
        const reasoningItems = output.filter(item => item?.type === 'reasoning' && item.encrypted_content);

        const usage = this._normalizeUsage(response.usage, { service_tier: response.service_tier });
        this._logUsage(usage, 'Responses');
        return {
            content: response.output_text || null,
            toolCalls: toolCalls.length ? toolCalls : null,
            stopReason: incompleteReason || null,
            usage,
            reasoningItems: reasoningItems.length ? reasoningItems : null,
            responseId: this.responsesStore ? (response.id || null) : null, // chaining only when stored
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * Responses API by default; Chat Completions on explicit opt-out.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const client = this.createClient(apiKey, { ...options, baseUrl });
        messages = await this._prepareMessages(messages);

        if (this.shouldUseResponsesApi(model, options)) {
            return this._streamResponses(client, model, messages, options, onEvent);
        }
        return this._streamCompletions(client, model, messages, options, onEvent);
    }

    async _streamCompletions(client, model, messages, options, onEvent) {
        const params = this._buildCompletionsParams(model, messages, options);
        params.stream = true;
        params.stream_options = { include_usage: true };

        log.info(`[${this.name}] SDK streaming (completions) for model:`, model);
        const stream = await client.chat.completions.create(params);

        // Accumulate tool calls across streaming chunks
        const toolCallAccumulator = {};
        /** @type {Record<string, any> | null} */
        let streamUsage = null;
        let streamFinishReason = null;

        for await (const chunk of stream) {
            // Capture usage from final chunk
            if (chunk.usage) {
                streamUsage = this._normalizeUsage(chunk.usage, { service_tier: chunk.service_tier });
                this._logUsage(streamUsage, 'Completions');
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
                onEvent('text', { text: delta.content });
            }
            // Accumulate tool call deltas
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallAccumulator[idx]) {
                        toolCallAccumulator[idx] = {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            arguments: '',
                        };
                    }
                    if (tc.id) toolCallAccumulator[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
                    if (tc.function?.arguments) {
                        toolCallAccumulator[idx].arguments += tc.function.arguments;
                        // Surface in-progress args so callers can live-stream a tool
                        // arg (e.g. notebook_write content) as it generates. Ignored
                        // by consumers that don't handle it.
                        const _acc = toolCallAccumulator[idx];
                        if (_acc.name) onEvent('tool_args_delta', { name: _acc.name, partial: _acc.arguments });
                    }
                }
            }
            // Check for finish_reason to emit accumulated tool calls
            const finishReason = chunk.choices?.[0]?.finish_reason;
            if (finishReason) streamFinishReason = finishReason;
            if (finishReason === 'tool_calls' || finishReason === 'stop') {
                for (const [, tc] of Object.entries(toolCallAccumulator)) {
                    this._emitToolCall(tc, onEvent);
                }
            }
        }

        if (streamFinishReason) {
            streamUsage = streamUsage || {};
            streamUsage.stop_reason = streamFinishReason;
        }
        onEvent('done', streamUsage || {});
    }

    /**
     * Emit one accumulated tool call, or drop it.
     *
     * Skip nameless tool calls (a malformed/garbled stream from a low-quality
     * model). Also DROP — rather than emit input:{} for — a call whose
     * accumulated arguments aren't valid JSON: a poisoned tool call gets echoed
     * back to the provider next round and can trigger an upstream 400 / spin
     * loop (BFSF-143). Emitting {} is worse than dropping, because a tool
     * invoked with no arguments still DOES something.
     */
    _emitToolCall(tc, onEvent) {
        if (!tc.name || !String(tc.name).trim()) {
            log.warn(`[${this.name}] Dropping nameless streamed tool call`);
            return;
        }
        let input;
        try {
            input = JSON.parse(tc.arguments || '{}');
        } catch (e) {
            log.warn(`[${this.name}] Dropping tool_use ${tc.name}: invalid JSON args (${e.message})`);
            return;
        }
        onEvent('tool_use', { id: tc.id, name: tc.name, input });
        log.info(`[${this.name}] Stream tool_use: ${tc.name}`);
    }

    async _streamResponses(client, model, messages, options, onEvent) {
        const params = this._buildResponsesParams(model, messages, options);
        params.stream = true;

        if (params.previous_response_id) {
            log.info(`[${this.name}] Streaming with previous_response_id:`, params.previous_response_id);
        }
        log.info(`[${this.name}] SDK streaming (responses, store=${this.responsesStore}) for model:`, model, 'reasoning:', JSON.stringify(params.reasoning || null));
        const stream = await client.responses.create(params);

        // Function calls in flight. A single slot loses calls whenever the model
        // emits parallel tools in one turn, which it does routinely — so they
        // are keyed.
        //
        // The key has to be `output_index`, because it is the ONLY field the
        // SDK puts on all three events: `response.output_item.added` carries
        // `item` + `output_index` and NO `item_id`, while the argument
        // delta/done events carry `item_id` + `output_index`. Keying on
        // `item_id ?? output_index` looks equivalent and is not: the call gets
        // stored under `0` and looked up under `fc_abc`, so nothing is ever
        // found and EVERY tool call is silently dropped. The item id is kept as
        // a secondary alias in case a future event omits the index.
        const fnCalls = new Map();
        const keysFor = (event) => {
            const keys = [];
            if (event.output_index !== undefined && event.output_index !== null) keys.push(`idx:${event.output_index}`);
            const itemId = event.item_id || event.item?.id;
            if (itemId) keys.push(`id:${itemId}`);
            if (!keys.length) keys.push('default');
            return keys;
        };
        const findCall = (event) => {
            for (const k of keysFor(event)) {
                const call = fnCalls.get(k);
                if (call) return call;
            }
            return null;
        };
        const dropCall = (event) => {
            for (const k of keysFor(event)) fnCalls.delete(k);
        };
        /** @type {Record<string, any> | null} */
        let streamUsage = null;
        const openThinkingParts = new Set();

        const closeThinking = () => {
            for (const partId of openThinkingParts) onEvent('thinking_stop', { partId });
            openThinkingParts.clear();
        };
        const captureResponse = (response) => {
            streamUsage = this._normalizeUsage(response?.usage, { service_tier: response?.service_tier }) || streamUsage || {};
            this._logUsage(streamUsage, 'Responses');
            if (response?.id) streamUsage.responseId = response.id;
            if (response?.status) streamUsage.stop_reason = response.status;
            // e.g. 'max_output_tokens' — surface this so truncations are visible
            if (response?.incomplete_details?.reason) {
                streamUsage.stop_reason = response.incomplete_details.reason;
            }
            const items = (response?.output || []).filter(i => i?.type === 'reasoning' && i.encrypted_content);
            if (items.length) streamUsage.reasoningItems = items;
        };

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (event.delta) onEvent('text', { text: event.delta });
            } else if (event.type === 'response.reasoning_summary_part.added'
                    || event.type === 'response.reasoning_summary_text.added') {
                // The SDK types no longer declare a `…text.added` event; the part
                // event is the real one. Both are handled, and a stream that
                // emits neither still opens the part on its first delta below.
                const partId = `openai-${event.summary_index ?? 0}`;
                if (!openThinkingParts.has(partId)) {
                    openThinkingParts.add(partId);
                    onEvent('thinking_start', { partId });
                }
            } else if (event.type === 'response.reasoning_summary_text.delta') {
                if (event.delta) {
                    const partId = `openai-${event.summary_index ?? 0}`;
                    if (!openThinkingParts.has(partId)) {
                        // Some stream flavours skip the `.added` event — open on first delta.
                        openThinkingParts.add(partId);
                        onEvent('thinking_start', { partId });
                    }
                    onEvent('thinking', { text: event.delta, partId });
                }
            } else if (event.type === 'response.reasoning_summary_text.done') {
                const partId = `openai-${event.summary_index ?? 0}`;
                if (openThinkingParts.has(partId)) {
                    openThinkingParts.delete(partId);
                    onEvent('thinking_stop', { partId });
                }
            } else if (event.type === 'response.output_item.added') {
                // New output item — could be a function call
                if (event.item?.type === 'function_call') {
                    const call = {
                        id: event.item.call_id || event.item.id,
                        name: event.item.name || '',
                        arguments: '',
                    };
                    for (const k of keysFor(event)) fnCalls.set(k, call);
                }
            } else if (event.type === 'response.function_call_arguments.delta') {
                const call = findCall(event);
                if (call && event.delta) {
                    call.arguments += event.delta;
                    // Match the Completions path: let callers live-stream a tool
                    // argument as it generates (the builder UI renders from this).
                    if (call.name) onEvent('tool_args_delta', { name: call.name, partial: call.arguments });
                }
            } else if (event.type === 'response.function_call_arguments.done') {
                const call = findCall(event);
                if (call) {
                    // `event.arguments` is the authoritative final value when present.
                    if (typeof event.arguments === 'string' && event.arguments) call.arguments = event.arguments;
                    this._emitToolCall(call, onEvent);
                    dropCall(event);
                }
            } else if (event.type === 'response.completed') {
                closeThinking();
                captureResponse(event.response);
            } else if (event.type === 'response.incomplete') {
                // Truncated (usually max_output_tokens). Without this the turn
                // ended in a bare `done` with no usage and no reason.
                closeThinking();
                captureResponse(event.response);
                streamUsage.stop_reason = event.response?.incomplete_details?.reason || 'incomplete';
                log.warn(`[${this.name}] Responses stream incomplete: ${streamUsage.stop_reason}`);
            } else if (event.type === 'response.failed' || event.type === 'error') {
                closeThinking();
                // Two different shapes: `response.failed` wraps the reason in
                // `response.error`, while a bare `error` event carries `message`
                // (and `code`/`param`) at the top level.
                const err = event.response?.error || event.error || {};
                const message = err.message || event.message || 'OpenAI Responses stream failed';
                log.error(`[${this.name}] Responses stream failed:`, message);
                onEvent('error', { error: message });
                streamUsage = streamUsage || {};
                streamUsage.stop_reason = 'error';
            }
        }

        closeThinking();
        onEvent('done', streamUsage || {});
    }

    /**
     * List models via SDK.
     */
    async listModels(apiKey, baseUrl) {
        try {
            const client = this.createClient(apiKey, { baseUrl });
            const response = await client.models.list();
            const models = [];
            for await (const model of response) {
                models.push({ id: model.id, name: model.id });
            }
            return models;
        } catch (e) {
            log.error(`[${this.name}] SDK listModels failed:`, e.message);
            return [];
        }
    }
}

module.exports = OpenAIProvider;
