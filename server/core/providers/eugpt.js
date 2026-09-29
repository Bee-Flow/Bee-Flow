// @typecheck
/**
 * EU GPT Provider Adapter
 *
 * EU GPT (eugpt.ai) serves open-weight models from Scaleway's EU regions behind
 * one endpoint, POST /v1/responses, in the shape of OpenAI's Responses API. It
 * is a much narrower API than that shape suggests, and every difference below
 * is one the generic OpenAI-compatible path would get wrong:
 *
 *  - There is no /v1/chat/completions. The whole request is rebuilt here, and
 *    the agent runtime must use this adapter rather than its raw-fetch path
 *    (roundRequest.js NATIVE_TYPES).
 *  - The model is always chosen by EU GPT's router. `model` must be "auto";
 *    the model it picked is reported back and passed on as `servedModel`.
 *  - No client tools. The API runs its own four (web_search, web_fetch,
 *    calculator, current_datetime) server-side and REPORTS them in the stream
 *    as `function_call` items. Those are never forwarded as `tool_use`: the
 *    tool loop would try to execute a call the provider already made.
 *    A forced single tool, the one thing structured-output callers need, is
 *    served as a JSON-schema answer instead (see _forcedTool).
 *  - `input` is one user message. Earlier turns are server-side state on EU
 *    GPT (`conversation_id`), which would put our history in their store, so
 *    the history travels as a transcript inside that message — in the user
 *    turn, not in `instructions`, so quoted user text never gains the
 *    authority of the system prompt.
 *  - Input parts are text or uploaded-file ids only; images are dropped.
 *  - No token usage in the response, so a turn reports no usage rather than
 *    an invented count. Read if EU GPT ever starts sending it.
 *
 * Docs: https://eugpt.ai/api
 */

const BaseProvider = require('./base');
const { EUGPT_WIRE_MODEL, describeEuGptModel } = require('./eugptModels');
const log = require('../../telemetry/log');

// Discovery must not hang a config screen. Chat calls use the caller's
// options.timeoutMs instead (see BaseProvider).
const DISCOVERY_TIMEOUT_MS = 8000;

// Warn once per process, not once per request, that client tools were dropped.
let _warnedToolsDropped = false;

class EuGptProvider extends BaseProvider {
    constructor() {
        super('eugpt');
    }

    getChatCompletionsPath() {
        return '/responses';
    }

    // ─── Model capabilities ──────────────────────────────────────────

    // A forced tool can only be served as structured output here, so this is
    // the route llmClient.chatForcedTool must take. EU GPT documents strict
    // json_schema output as enforced, loose schemas included.
    supportsStructuredOutput(_modelId, schema) {
        return !!schema && typeof schema === 'object';
    }

    // Some models behind the router write their reasoning as literal <think>
    // text; that is raw reasoning, so the tier's Reasoning Summary switch is
    // honoured here.
    surfacesRawReasoning() {
        return true;
    }

    // ─── Request building ────────────────────────────────────────────

    /**
     * The one tool the caller forces, as { name, description, schema }, or null
     * when no tool is forced. A tool list without a forced choice is dropped:
     * EU GPT has no client tools, and answering in prose is the honest
     * fallback. Forcing "any of several" cannot be served at all, so it fails
     * loudly rather than returning prose to a loop that is waiting for a call.
     */
    _forcedTool(options = {}) {
        const tools = Array.isArray(options.tools) ? options.tools : [];
        if (!tools.length) return null;

        const nameOf = (t) => t?.function?.name || t?.name || '';
        const choice = options.toolChoice;
        let wanted = null;
        if (choice && typeof choice === 'object') {
            // OpenAI {type:'function', function:{name}} or Claude {type:'tool', name}.
            wanted = choice.function?.name || choice.name || null;
        } else if ((choice === 'required' || choice === 'any') && tools.length === 1) {
            wanted = nameOf(tools[0]);
        }

        if (wanted) {
            const tool = tools.find(t => nameOf(t) === wanted);
            if (!tool) throw new Error(`${this.name}: forced tool "${wanted}" is not in the tool list`);
            return {
                name: wanted,
                description: tool.function?.description || tool.description || '',
                schema: tool.function?.parameters || tool.parameters || tool.input_schema || { type: 'object' },
            };
        }
        if (choice === 'required' || choice === 'any') {
            throw new Error(`${this.name} cannot call client tools (tool_choice "${choice}" over ${tools.length} tools); use a model with tool support for this task`);
        }
        if (choice !== 'none' && !_warnedToolsDropped) {
            _warnedToolsDropped = true;
            log.warn(`[${this.name}] EU GPT has no client tools; tool lists are dropped and the model answers without them`);
        }
        return null;
    }

    /** The requested output format, normalised to { type, name?, schema? }, or null. */
    _outputFormat(options = {}, forced = null) {
        if (forced) return { type: 'json_schema', name: forced.name, schema: forced.schema };
        const rf = options.responseFormat || options.responseSchema;
        if (!rf) return null;
        if (rf.type === 'json_schema' && rf.json_schema) {
            return { type: 'json_schema', name: rf.json_schema.name || 'response', schema: rf.json_schema.schema };
        }
        if (rf.type === 'json_object') return { type: 'json_object' };
        if (rf.schema || rf.properties) {
            return { type: 'json_schema', name: rf.name || 'response', schema: rf.schema || rf };
        }
        return null;
    }

    /** Plain text of a message's content; parts EU GPT cannot take become a marker. */
    _textOf(content) {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            if (/image/.test(String(part.type || ''))) return '[image omitted]';
            if (part.type === 'document' || part.type === 'file') return '[document omitted]';
            return '';
        }).filter(Boolean).join('\n');
    }

    /** One transcript line (or block) for a non-system message. */
    _renderTurn(m) {
        const text = this._textOf(m.content).trim();
        if (m.role === 'tool') {
            return `Tool result (${m.name || m.tool_call_id || 'tool'}):\n${text}`;
        }
        if (m.role === 'assistant') {
            const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map(tc => {
                const name = tc.function?.name || tc.name || 'tool';
                const args = tc.function?.arguments ?? JSON.stringify(tc.input || {});
                return `[called ${name} with ${typeof args === 'string' ? args : JSON.stringify(args)}]`;
            });
            return ['Assistant:', text, ...calls].filter(Boolean).join('\n');
        }
        return `User:\n${text}`;
    }

    /**
     * Messages → { instructions, input }. System (and developer) messages
     * become `instructions`; the last message is the input, and everything
     * between is a transcript placed ahead of it in the same user message.
     */
    toEuGptInput(messages = []) {
        const system = [];
        const turns = [];
        for (const m of messages) {
            if (!m) continue;
            if (m.role === 'system' || m.role === 'developer') {
                const text = this._textOf(m.content).trim();
                if (text) system.push(text);
            } else {
                turns.push(m);
            }
        }

        const last = turns[turns.length - 1];
        const earlier = turns.slice(0, -1);
        let current = '';
        if (last) {
            current = last.role === 'user' ? this._textOf(last.content).trim() : this._renderTurn(last);
        }
        // An empty input is a 400. The only way here is a turn that ends on an
        // assistant message with nothing in it (a continuation).
        if (!current) current = 'Continue.';

        const input = earlier.length
            ? `[Earlier in this conversation]\n\n${earlier.map(m => this._renderTurn(m)).join('\n\n')}\n\n[Current message]\n\n${current}`
            : current;

        return { instructions: system.join('\n\n'), input };
    }

    /**
     * A Responses body (`input`, no `messages`), so not the Chat Completions
     * shape BaseProvider's return type is inferred from.
     * @returns {any}
     */
    buildRequestBody(_model, messages, options = {}) {
        const forced = this._forcedTool(options);
        const { instructions, input } = this.toEuGptInput(messages);

        /** @type {Record<string, any>} */
        const body = { model: EUGPT_WIRE_MODEL, input, stream: !!options.stream };

        let system = instructions;
        if (forced) {
            // The schema says what shape to answer in; the tool's description
            // is often the only place that says what to put in it.
            const what = forced.description ? `: ${forced.description}` : '';
            system = [system, `Answer only with the JSON arguments for "${forced.name}"${what}`].filter(Boolean).join('\n\n');
        }
        if (system) body.instructions = system;

        // Only an explicit cap is sent: omitted, the routed model's own maximum
        // applies, and a value above it is clamped rather than refused.
        const maxTokens = options.maxTokens ?? options.max_tokens;
        if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_output_tokens = maxTokens;

        // Structured output. The docs spell it `text.format` (Responses) and the
        // published OpenAPI spec `response_format` (Chat Completions); both are
        // sent, identical, and the backend reads whichever it knows. Forcing a
        // schema also switches EU GPT's server-side tools off for the request.
        const format = this._outputFormat(options, forced);
        if (format?.type === 'json_object') {
            body.text = { format: { type: 'json_object' } };
            body.response_format = { type: 'json_object' };
        } else if (format) {
            const name = String(format.name || 'response').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'response';
            body.text = { format: { type: 'json_schema', name, schema: format.schema, strict: true } };
            body.response_format = { type: 'json_schema', json_schema: { name, schema: format.schema, strict: true } };
        }

        // Escape hatch for EU GPT's own fields (project_id for its RAG, …).
        if (options.extraBody) Object.assign(body, options.extraBody);
        return body;
    }

    // ─── Responses ───────────────────────────────────────────────────

    _normalizeUsage(usage) {
        if (!usage || typeof usage !== 'object') return null;
        const prompt = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        const completion = usage.output_tokens ?? usage.completion_tokens ?? 0;
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: usage.total_tokens ?? (prompt + completion),
            cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
            reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        };
    }

    /** 'stop' | a truncation reason — the codebase-wide `stop_reason` vocabulary. */
    _stopReason(response) {
        if (response?.incomplete_details?.reason) return response.incomplete_details.reason;
        if (response?.status === 'incomplete') return 'incomplete';
        return 'stop';
    }

    /** The final text of a response object: `output_text`, else its message parts. */
    _outputText(data) {
        if (typeof data?.output_text === 'string') return data.output_text;
        return (Array.isArray(data?.output) ? data.output : [])
            .filter(item => item?.type === 'message' && Array.isArray(item.content))
            .flatMap(item => item.content)
            .filter(part => typeof part?.text === 'string')
            .map(part => part.text)
            .join('');
    }

    /** A forced tool's answer as a tool call, or null when it is not a JSON object. */
    _forcedCall(forced, text, responseId) {
        let parsed;
        try { parsed = JSON.parse(text); } catch { return null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return { id: `call_${responseId || Date.now().toString(36)}`, name: forced.name, input: parsed };
    }

    _parseNonStreamingResponse(data, options = {}) {
        const forced = this._forcedTool(options);
        const { extractThinkBlocks } = require('./thinkTagStream');
        const { content, thinking: tagThinking } = extractThinkBlocks(this._outputText(data) || null);
        const thinking = this._wantsThinking(options) ? tagThinking : null;
        const base = {
            ...(thinking ? { thinking } : {}),
            usage: this._normalizeUsage(data?.usage),
            stop_reason: this._stopReason(data),
            ...(data?.model ? { servedModel: data.model } : {}),
            raw: data,
        };

        if (forced) {
            const call = this._forcedCall(forced, content || '', data?.id);
            if (call) {
                return {
                    ...base,
                    content: null,
                    toolCalls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: content } }],
                };
            }
            // Not JSON after all: hand the text back, where llmClient's
            // extractForcedResult still looks for (and loosely parses) it.
            log.warn(`[${this.name}] forced ${forced.name}: the answer was not a JSON object`);
        }
        return { ...base, content: content || null, toolCalls: null };
    }

    /**
     * Parse EU GPT's SSE stream. Every frame is `event: message` with the type
     * in the JSON; unknown types are ignored, as the docs ask.
     */
    async _parseSseStream(body, onEvent, options = {}) {
        const forced = this._forcedTool(options);
        const decoder = new TextDecoder();
        let buffer = '';
        let streamed = '';
        /** @type {string | null} */
        let finalText = null;
        let responseId = null;
        let servedModel = null;
        let usage = null;
        let stopReason = null;
        let failed = false;

        // Thinking only ever arrives as in-band <think> text, so one part.
        const wantThinking = this._wantsThinking(options);
        const partId = 'eugpt-0';
        let thinkingOpen = false;
        const openThinking = () => {
            if (wantThinking && !thinkingOpen) {
                thinkingOpen = true;
                onEvent('thinking_start', { partId });
            }
        };
        const emitThinking = (text) => {
            if (!wantThinking || !text) return;
            openThinking();
            onEvent('thinking', { text, partId });
        };
        const closeThinking = () => {
            if (thinkingOpen) {
                thinkingOpen = false;
                onEvent('thinking_stop', { partId });
            }
        };
        const { createThinkTagSplitter, extractThinkBlocks } = require('./thinkTagStream');
        const splitter = createThinkTagSplitter({
            onText: (text) => { closeThinking(); onEvent('text', { text }); },
            onThinkingStart: openThinking,
            onThinking: (text) => emitThinking(text),
            onThinkingStop: closeThinking,
        });
        const pushText = (text) => {
            if (!text) return;
            streamed += text;
            if (forced) {
                // A forced answer is the tool call's arguments, not prose. It
                // is emitted once, parsed, at the end; the partial JSON goes
                // out the same way a streamed tool argument does.
                onEvent('tool_args_delta', { name: forced.name, partial: streamed });
            } else {
                splitter.push(text);
            }
        };

        const handle = (event) => {
            switch (event.type) {
                case 'response.created':
                    responseId = event.response?.id || responseId;
                    servedModel = event.response?.model || servedModel;
                    break;
                case 'response.routing.completed':
                    servedModel = event.model_id || servedModel;
                    log.debug(`[${this.name}] routed to ${servedModel} (${event.category || 'n/a'})`);
                    break;
                case 'response.output_text.delta':
                    pushText(event.delta);
                    break;
                case 'response.output_item.added':
                case 'response.output_item.done':
                    // EU GPT's own tools, already run on its side. Logged, never
                    // forwarded as tool_use (see the header).
                    if (event.type === 'response.output_item.done' && event.item && event.item.type !== 'message') {
                        log.debug(`[${this.name}] server-side ${event.item.name || event.item.type}: ${event.item.status || 'done'}`);
                    }
                    break;
                case 'response.completed':
                    responseId = event.response?.id || responseId;
                    servedModel = event.response?.model || servedModel;
                    usage = this._normalizeUsage(event.response?.usage);
                    stopReason = this._stopReason(event.response);
                    if (typeof event.response?.output_text === 'string') finalText = event.response.output_text;
                    break;
                case 'error': {
                    failed = true;
                    stopReason = 'error';
                    const message = [event.code, event.message].filter(Boolean).join(': ') || 'EU GPT stream failed';
                    log.error(`[${this.name}] stream failed: ${message}`);
                    onEvent('error', { error: message });
                    break;
                }
                default:
                    break;
            }
        };

        const readLine = (line) => {
            if (!line.startsWith('data:')) return;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') return;
            let event;
            try { event = JSON.parse(data); } catch { return; }
            if (event && typeof event === 'object') handle(event);
        };

        for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) readLine(line.replace(/\r$/, ''));
        }
        if (buffer) readLine(buffer.replace(/\r$/, ''));

        // The completed event carries the final text, which is what the deltas
        // should add up to. A missing tail (a dropped frame) is appended. A
        // different text means EU GPT's post-generation rewrite pass changed
        // what was already streamed; that cannot be taken back, so it is only
        // logged.
        if (!failed && finalText !== null && finalText !== streamed) {
            if (finalText.startsWith(streamed)) pushText(finalText.slice(streamed.length));
            else log.warn(`[${this.name}] final text differs from the streamed text (rewrite pass); keeping what was streamed`);
        }
        splitter.flush();
        closeThinking();

        if (forced && !failed) {
            const text = (extractThinkBlocks(streamed).content || '').trim();
            const call = this._forcedCall(forced, text, responseId);
            if (call) {
                onEvent('tool_use', call);
            } else {
                log.warn(`[${this.name}] forced ${forced.name}: the answer was not a JSON object`);
                onEvent('tool_use_invalid', { id: `call_${responseId || 'eugpt'}`, name: forced.name, arguments: text, error: 'not a JSON object' });
            }
        }

        onEvent('done', {
            ...(usage || {}),
            ...(stopReason ? { stop_reason: stopReason } : {}),
            ...(servedModel ? { servedModel } : {}),
        });
    }

    // ─── Model discovery ─────────────────────────────────────────────

    /**
     * The routed model, once the key is known to work. There is no model list
     * to fetch, so the key is checked against the cheapest authenticated call
     * there is (list one uploaded file). A rejected key yields nothing: a
     * provider that appears to serve a model it cannot reach wins model
     * resolution and 401s every chat routed to it. Auth runs before routing on
     * EU GPT, so a 404 still means the key was accepted.
     */
    async listModels(apiKey, baseUrl) {
        if (!apiKey) return [];
        const root = (baseUrl || '').replace(/\/+$/, '');
        const url = `${root.endsWith('/v1') ? root : `${root}/v1`}/files?limit=1`;

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
            try {
                const res = await fetch(url, { headers: this.getHeaders(apiKey), signal: controller.signal });
                if (!res.ok && res.status !== 404 && res.status !== 405) throw new Error(`HTTP ${res.status}`);
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            log.warn(`[${this.name}] key check failed: ${e.message}`);
            return [];
        }
        return [describeEuGptModel()];
    }
}

module.exports = EuGptProvider;
