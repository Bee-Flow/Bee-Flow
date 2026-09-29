// @typecheck
/**
 * LLM Client — Unified facade for all LLM provider interactions.
 * 
 * Routes call this instead of touching provider adapters directly.
 * Handles: provider resolution, adapter selection, normalized event dispatching.
 */

const { getAdapter, GoogleProvider, LocalProvider } = require('../providers/index');
const { getProviderForModel } = require('../aiAgent');
const { parseGemmaArgs, recoverLeakedToolCalls, hasLeakedToolCallSyntax } = require('./leakedToolCalls');
const { looksGarbled } = require('./partialJsonScan');
const log = require('../../telemetry/log');

// How much of an unparsable argument string one warning may carry: enough
// for a whole compose answer to become a parser fixture, never a batch dump.
const UNPARSABLE_LOG_CHARS = 4096;

/**
 * Build the provider-correct `toolChoice` that forces the model to call exactly
 * one named tool. This is the fallback route to structured output, for the
 * adapters that do not honour `response_format` / `json_schema` natively —
 * which, until the OpenAI adapter grew `supportsStructuredOutput()`, was all of
 * them. See chatForcedTool for when each route is taken.
 *
 * - openai / claude / mistral / generic OpenAI-compatible adapters all accept the
 *   OpenAI object form `{type:'function',function:{name}}`:
 *     · openai.js  → mapToolChoice passes objects through
 *     · claude.js  → maps an object with `.name` → {type:'tool',name}
 *     · mistral.js → mapToolChoice passes objects through (Mistral wire format
 *                    accepts {type:'function',function:{name}})
 *     · base.js    → tool_choice = options.toolChoice (object passthrough)
 * - GOOGLE (and google-vertex, which extends GoogleProvider) has NO object/name
 *   case — it only maps 'required'/'any' → functionCallingConfig.mode ANY. With a
 *   SINGLE-tool list, mode ANY is equivalent to forcing that one tool, so we pass
 *   the string 'required' instead of the object. Callers must also pass a
 *   single-tool list (tools:[toolDef]) for Google forcing to be deterministic.
 * - SELF-HOSTED runtimes (every LocalProvider flavour) get 'required' for the
 *   same reason. llama-server reads `tool_choice` as a STRING and answers the
 *   object form with a "Wrong type supplied" warning and the default, auto:
 *   measured 2026-09-17, 253 such warnings in three days, every forced call
 *   on the demo box unforced. vLLM and SGLang accept both forms, LM Studio the
 *   strings, Ollama ignores the field either way — so with the single-tool
 *   list every caller passes, 'required' is exactly "call that tool" on all
 *   of them and the object form is never the better choice.
 *
 * @param {object} adapter   - resolved provider adapter instance
 * @param {string} toolName  - the function name to force
 * @returns {object|string}  - object form, or 'required' for the Google family
 *                             and the self-hosted runtimes
 */
function forcedToolChoice(adapter, toolName) {
    // Single-tool list + 'required' === force-that-tool on these families.
    if (adapter instanceof GoogleProvider || adapter instanceof LocalProvider) {
        return 'required';
    }
    return { type: 'function', function: { name: toolName } };
}

/**
 * Best-effort parse of a forced tool call's arguments into a plain object,
 * plus what it was parsed from.
 * Arguments arrive as a JSON string (OpenAI/Mistral/generic) or as an already
 * parsed object (Claude/Google `input`). Never throws — `structured` is null
 * on any absence/parse failure so callers get untrusted-but-safe output.
 *
 * A string that is not valid JSON gets one more chance: a trailing
 * `<tool_call|>…` tail (the model's close token and whatever followed it)
 * is cut off and the loose parser reads what is left — Gemma's own fence
 * syntax, bare-word values, a batch cut right after a complete entry. What
 * it accepts is exactly what was on the wire, never a guess (see the grammar
 * note in core/llm/leakedToolCalls); `repaired` says the loose route was taken.
 *
 * @returns {{ structured: object|null, rawArguments: string|null, repaired: boolean }}
 */
function parseToolCallArgsDetailed(toolCall) {
    const none = { structured: null, rawArguments: null, repaired: false };
    if (!toolCall) return none;
    const rawArgs = toolCall.function?.arguments ?? toolCall.input;
    if (rawArgs == null) return none;
    if (typeof rawArgs === 'object') return { structured: rawArgs, rawArguments: null, repaired: false };
    if (typeof rawArgs !== 'string') return none;
    try {
        const parsed = JSON.parse(rawArgs);
        return { structured: parsed && typeof parsed === 'object' ? parsed : null, rawArguments: rawArgs, repaired: false };
    } catch {
        const untailed = rawArgs.replace(/<tool_call\|>[\s\S]*$/, '');
        const loose = parseGemmaArgs(untailed);
        return { structured: loose && typeof loose === 'object' ? loose : null, rawArguments: rawArgs, repaired: !!loose };
    }
}

/** The object alone — the shape every existing caller reads. */
function parseToolCallArgs(toolCall) {
    return parseToolCallArgsDetailed(toolCall).structured;
}

/**
 * Does a parsed argument object carry the signature of a value that
 * swallowed structure? Two signals: partialJsonScan.looksGarbled (a `},key:`
 * run or `}}}` inside a string — llama.cpp's PEG parser cutting a string at
 * a brace, issue #21384) and a tool-call control token inside any value,
 * which looksGarbled's regex does not see (`"text}]}}]}<tool_call|>…"` has
 * neither `}}}` nor `},key:`). Both mean valid JSON with wrong values; the
 * caller still gets the object, the log gets the warning.
 */
function argsLookGarbled(structured) {
    if (!structured || typeof structured !== 'object') return false;
    if (looksGarbled(structured)) return true;
    try { return hasLeakedToolCallSyntax(JSON.stringify(structured)); } catch { return false; }
}

/**
 * Best-effort parse of a native structured-output response body. Same contract
 * as parseToolCallArgs: never throws, null when there is no usable object.
 * Tolerates a model that wrapped its JSON in a fenced code block.
 */
function _parseJsonContent(content) {
    if (!content || typeof content !== 'string') return null;
    let text = content.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fenced) text = fenced[1].trim();
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The stop reason of a non-streaming chat result, whichever way the adapter
 * spelled it. base.js says `stop_reason` (the codebase-wide name), openai.js
 * and claude.js `stopReason`; Google reports none. Null when absent — never
 * a guess, because a caller keys "cut off" decisions on it.
 */
function readStopReason(result) {
    return result?.stop_reason ?? result?.stopReason ?? null;
}

/**
 * Read a forced tool call's answer out of a chat result, wherever the model
 * put it. The ladder, most to least precise:
 *   1. the tool call whose name matches `toolName` — a model with several
 *      calls in one reply (or one that called something else first) is read
 *      by name, not by position; the first call is the fallback;
 *   2. a call the model WROTE instead of made, in the content or in its
 *      reasoning (`<|tool_call>call:NAME{…}`, Hermes `<tool_call>`, or a reply
 *      that is one `{"name","arguments"}` object) — recoverLeakedToolCalls
 *      only accepts `toolName`, so a legitimate `{name: …}` answer body is
 *      never mistaken for a call wrapper;
 *   3. the content as JSON (a small local model that answers in prose with the
 *      object in it, fenced or bare).
 * The stop reason is passed through so a caller can tell "the model declined"
 * (stop) from "the model was cut off" (length / max_tokens) — the same null
 * `structured` otherwise. The adapters spell it two ways: base.js (every
 * OpenAI-compatible runtime) hands up `stop_reason`, openai.js and claude.js
 * `stopReason`, google.js neither — so both are read here, or a GPT or Claude
 * answer cut at the length limit would report null and a composer would ship
 * the truncated document instead of its `compose_truncated` refusal.
 * `rawArguments` is the argument string as it arrived (null when the
 * provider handed up an object), for a repair round that quotes it back.
 *
 * Nothing here throws. An unparsable argument string is logged with up to
 * 4 kB of it — the compose failures of 2026-09-17 were invisible until then
 * — and an object that parsed but looks garbled is logged as such while the
 * caller still gets it (the tool's own validation decides).
 *
 * @param {object} result   - what adapter.chat returned
 * @param {string} toolName - the forced tool's function name
 * @param {{ modelId?: string }} [ctx] - for the log line only
 * @returns {{ structured: object|null, content: string|null, usage: object|undefined, raw: any,
 *             stopReason: string|null, rawArguments: string|null }}
 */
function extractForcedResult(result, toolName, { modelId = '?' } = {}) {
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    const named = calls.find(tc => (tc?.function?.name || tc?.name) === toolName) || calls[0] || null;
    const stopReason = readStopReason(result);

    let { structured, rawArguments, repaired } = parseToolCallArgsDetailed(named);
    let source = structured ? (repaired ? 'tool_call (loose parse)' : 'tool_call') : null;

    if (!structured) {
        const content = typeof result?.content === 'string' ? result.content : null;
        const thinking = typeof result?.thinking === 'string' ? result.thinking : '';
        // Only when there is a call to find: the wire syntax, or a bare JSON
        // reply that names the tool. A plain JSON answer body with its own
        // `name` field is step 3's business, not a call wrapper to reject.
        const worthScanning = hasLeakedToolCallSyntax(content) || hasLeakedToolCallSyntax(thinking)
            || (!!content && !!toolName && content.trim().startsWith('{') && content.includes(toolName));
        if (worthScanning) {
            const thinkingParts = thinking ? [{ text: thinking }] : [];
            const recovered = recoverLeakedToolCalls({ content, thinkingParts }, { toolNames: new Set(toolName ? [toolName] : []) });
            const call = recovered.toolCalls.find(tc => tc.function?.name === toolName) || null;
            if (call) {
                try { structured = JSON.parse(call.function.arguments); } catch { structured = null; }
                if (structured) {
                    source = `written as text in the ${call._recoveredFrom}`;
                    if (rawArguments == null) rawArguments = call.function.arguments;
                }
            }
        }
    }
    if (!structured) {
        structured = _parseJsonContent(result?.content);
        if (structured) source = 'content';
    }

    if (!structured) {
        if (typeof rawArguments === 'string' && rawArguments.trim()) {
            log.warn(`[LLMClient] forced tool ${toolName} on ${modelId}: arguments unparsable (stop=${stopReason || '?'}, ${rawArguments.length} chars): ${rawArguments.slice(0, UNPARSABLE_LOG_CHARS)}`);
        }
    } else {
        if (source !== 'tool_call') {
            log.warn(`[LLMClient] forced tool ${toolName} on ${modelId}: answer read from ${source} (stop=${stopReason || '?'})`);
        }
        if (argsLookGarbled(structured)) {
            log.warn(`[LLMClient] forced tool ${toolName} on ${modelId}: args look garbled — a string value swallowed structure (llama.cpp Gemma parser, #21384); stop=${stopReason || '?'}`);
        }
    }

    return {
        structured: structured || null,
        content: result?.content ?? null,
        usage: result?.usage,
        raw: result?.raw,
        stopReason,
        rawArguments: typeof rawArguments === 'string' ? rawArguments : null,
    };
}

class LLMClient {
    /**
     * Resolve the provider config + adapter for a model.
     * @returns {Promise<{ apiKey: string, baseUrl: string, adapter: any, providerType: string, modelId: string,
     *   project: string|null, location: string|null, serviceAccountKey: any, apiVersion: string|null }>}
     */
    async _resolve(modelId) {
        const config = await getProviderForModel(modelId);
        const baseUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, baseUrl);
        return {
            apiKey: config.apiKey || '',
            baseUrl,
            adapter,
            providerType: config.providerType || adapter.name,
            modelId: config.model || modelId,
            project: config.project || null,
            location: config.location || null,
            serviceAccountKey: config.serviceAccountKey || null,
            // apiVersion is required by the Azure adapter (api-version query
            // param). The direct-chat tier path forwards it; dropping it here
            // silently broke Azure-hosted calls (e.g. title generation).
            apiVersion: config.apiVersion || null,
        };
    }

    /**
     * Non-streaming chat completion.
     * @returns {Promise<{content, toolCalls, usage}>}
     */
    async chat(modelId, messages, options = {}) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = await this._resolve(modelId);
        return adapter.chat(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey, apiVersion });
    }

    /**
     * Structured output: get a typed object back from a model.
     *
     * Two routes, in order of reliability:
     *
     *  1. NATIVE — `response_format` / `text.format` with the tool's JSON
     *     schema, when the adapter says it can GUARANTEE that schema
     *     (`supportsStructuredOutput(modelId, schema)`). The provider then
     *     constrains decoding, so the answer conforms by construction rather
     *     than by the model's good intentions.
     *  2. FORCED TOOL — force the model to call exactly one named tool and read
     *     that call's arguments (see forcedToolChoice). This is what every
     *     adapter could always do, and it stays the route for providers with no
     *     native support and for schemas too loose to be enforced — which is
     *     most hand-written ones, since strict mode demands every object be
     *     closed and every property required.
     *
     * The decision is made BEFORE the call, not by trying native and retrying:
     * a probe-then-fallback would double the cost of every loose schema.
     *
     * The model's output is UNTRUSTED either way — `structured` is null when the
     * model declined or emitted something unparseable. This never throws on the
     * parse path; callers must clamp/validate the returned object.
     *
     * @param {string} modelId
     * @param {Array}  messages  - chat messages
     * @param {object} toolDef   - OpenAI-format tool def: {type:'function',function:{name,description,parameters}}
     * @param {object} [options] - extra chat options (maxTokens, temperature, …); tools/toolChoice are overridden
     * @returns {Promise<{structured: object|null, content: string|null, usage: object|undefined, raw: any,
     *                    stopReason: string|null, rawArguments: string|null}>}
     *   `stopReason` ('stop' | 'length' | …, null when the adapter reports none)
     *   and `rawArguments` (the argument string as it arrived, null for an
     *   object or the native route) are additive — see extractForcedResult.
     */
    async chatForcedTool(modelId, messages, toolDef, options = {}) {
        const resolved = await this._resolve(modelId);
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = resolved;
        const providerOpts = { project, location, serviceAccountKey, apiVersion };
        const toolName = toolDef?.function?.name;
        const schema = toolDef?.function?.parameters;

        if (schema && adapter.supportsStructuredOutput?.(modelId, schema)) {
            const native = await adapter.chat(apiKey, baseUrl, modelId, messages, {
                ...options,
                ...providerOpts,
                responseFormat: {
                    type: 'json_schema',
                    json_schema: { name: toolName || 'response', schema },
                },
            });
            const structured = _parseJsonContent(native?.content);
            if (structured) {
                return {
                    structured,
                    content: native?.content ?? null,
                    usage: native?.usage,
                    raw: native?.raw,
                    stopReason: readStopReason(native),
                    rawArguments: null,
                };
            }
            // The adapter said it could enforce this schema and we still got
            // nothing parseable. Rare enough to be worth one retry on the route
            // that has always worked, rather than handing the caller a null.
            log.warn(`[LLMClient] Native structured output gave nothing parseable for ${modelId}; falling back to a forced tool call`);
        }

        const forcedOpts = {
            ...options,
            ...providerOpts,
            tools: [toolDef],
            toolChoice: forcedToolChoice(adapter, toolName),
        };
        // A self-hosted runtime gets the tool itself as well: on llama-server
        // the adapter answers a forced call as grammar-enforced JSON
        // (LocalProvider._forcedToolAsJsonSchema) — the native tool-call
        // route lost whole designs to the PEG parser on 2026-09-18. Other
        // runtimes ignore the field and take the tool route below.
        if (adapter instanceof LocalProvider && schema) {
            try {
                const viaGrammar = await adapter.chat(apiKey, baseUrl, modelId, messages, { ...forcedOpts, forcedTool: toolDef });
                const read = extractForcedResult(viaGrammar, toolName, { modelId });
                if (read.structured) return read;
                log.warn(`[LLMClient] forced tool ${toolName} on ${modelId}: the grammar route gave nothing parseable (stop=${read.stopReason}); trying the tool route once`);
            } catch (e) {
                // A schema the grammar builder refuses (llama-server answers 400)
                // is the one case the tool route can still serve.
                if (!/API error 4\d\d/.test(String(e && e.message))) throw e;
                log.warn(`[LLMClient] forced tool ${toolName} on ${modelId}: the grammar route was refused (${String(e.message).slice(0, 160)}); trying the tool route once`);
            }
        }

        const result = await adapter.chat(apiKey, baseUrl, modelId, messages, forcedOpts);
        // A small local model often writes the JSON into the message — or the
        // whole call into its reasoning — instead of into a tool call (see
        // providers/local.js on llama-server's tool handling). Every shape it
        // has been seen to use is read by extractForcedResult; returning
        // `structured: null` for an answer that was sitting in `content` all
        // along made every caller report "the model answered nothing".
        return extractForcedResult(result, toolName, { modelId });
    }

    /**
     * The provider-correct forced `toolChoice` for a model, for a caller that
     * builds its own `chat` options (a route with a user-supplied schema)
     * instead of going through chatForcedTool. Resolves the adapter the same
     * way chat() will, so the two never disagree.
     */
    async forcedToolChoiceFor(modelId, toolName) {
        const { adapter } = await this._resolve(modelId);
        return forcedToolChoice(adapter, toolName);
    }

    /**
     * Streaming chat completion with normalized event callbacks.
     * @param {function} onEvent - Called with (type, data):
     *   text, thinking, tool_use, done, error
     */
    async stream(modelId, messages, options = {}, onEvent) {
        const { apiKey, baseUrl, adapter, project, location, serviceAccountKey, apiVersion } = await this._resolve(modelId);
        return adapter.stream(apiKey, baseUrl, modelId, messages, { ...options, project, location, serviceAccountKey, apiVersion }, onEvent);
    }

    /**
     * Build the tool-free [system, user] message pair for title generation.
     * Returns null when there's no usable user content.
     */
    _buildTitleMessages(userMessage, systemPrompt, maxInputChars = 500) {
        // Empty/whitespace user content is a fast no-op: Anthropic and others
        // reject `messages.0` with no content.
        const safeUserContent = typeof userMessage === 'string'
            ? userMessage.slice(0, maxInputChars)
            : (userMessage == null ? '' : JSON.stringify(userMessage).slice(0, maxInputChars));
        if (!safeUserContent || !safeUserContent.trim()) return null;
        // Title generation is a tool-free task. State that explicitly so the
        // model doesn't try to "use" tools or emit code blocks — observed when
        // a tool-heavy chat's transcript primes it toward code output.
        const toolFreeNote = 'You have NO tools and cannot browse the web or run code — only read the conversation and output a short title (no code blocks).';
        const defaultTitlePrompt = `You are naming a chat conversation. ${toolFreeNote} Output a short 2-5 word title (max ~40 characters) describing its topic. Output ONLY the title — no quotes, no extra text.`;
        // Ensure the tool-free guarantee is present even when an admin-edited
        // system-agent prompt (which predates this) is supplied.
        let titleSystemPrompt = defaultTitlePrompt;
        if (systemPrompt && systemPrompt.trim()) {
            titleSystemPrompt = /no tools/i.test(systemPrompt) ? systemPrompt : `${systemPrompt}\n\n${toolFreeNote}`;
        }
        return [
            { role: 'system', content: titleSystemPrompt },
            { role: 'user', content: safeUserContent },
        ];
    }

    /**
     * Defensive title sanitisation — strip code fences/tags, collapse, cap.
     *
     * A model tuned for structured output (an "-extract" fine-tune, or one
     * primed by a JSON-heavy transcript) answers with a record instead of a
     * phrase: `{"title": "Bee Flow deck", "excerpt": "..."}`. Stripping the
     * quotes from that gave the sidebar `{ title: Bee Flow deck, exce…` for
     * every chat (2026-09-18). When the answer parses as an object, take its
     * title-like field; when it opens like one but doesn't parse, it is not a
     * title at all.
     */
    _sanitiseTitle(raw) {
        let text = (raw || '').trim();
        if (/^```/.test(text)) {
            // An extract model wraps its record in ```json fences: unwrap and
            // read the record below. Any other fenced block is hallucinated code.
            const fence = /^```[a-z]*\s*([\[{][\s\S]*?)\s*```$/i.exec(text);
            if (!fence) return 'New Chat';
            text = fence[1].trim();
        }
        if (/^[\[{]/.test(text)) {
            const TITLE_KEYS = ['title', 'name', 'subject', 'topic'];
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (_) { /* fall through to the field scan */ }
            if (Array.isArray(parsed)) parsed = parsed[0];
            let picked = parsed && typeof parsed === 'object'
                ? TITLE_KEYS.map(k => parsed[k]).find(v => typeof v === 'string' && v.trim())
                : null;
            if (!picked) {
                // The record is usually cut off by the 64-token cap before it
                // closes, so it never parses — but the title field is first.
                const m = new RegExp(`"(?:${TITLE_KEYS.join('|')})"\\s*:\\s*"([^"\\n]+)"`, 'i').exec(text);
                picked = m ? m[1] : null;
            }
            if (!picked) return 'New Chat';
            text = picked;
        }
        let cleaned = text.replace(/[\"']/g, '');
        cleaned = cleaned.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'New Chat';
        if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).trim();
        return cleaned;
    }

    /**
     * Generate a title using an ALREADY-RESOLVED provider/adapter — the exact
     * same primitives the direct-chat tier path uses (getProviderForModel +
     * getAdapter → adapter.chat(apiKey, apiUrl, modelId, msgs, { …, apiVersion })).
     * Callers that have already resolved the provider (e.g. directChat, which
     * shares the conversation's adapter) pass it in so there's no second
     * lookup and no chance of a divergent resolution.
     * @param {{adapter, apiKey, apiUrl, modelId, apiVersion}} provider
     */
    async generateTitleWithProvider(provider, userMessage, systemPrompt, options = {}) {
        const { adapter, apiKey, apiUrl, modelId, apiVersion } = provider || {};
        if (!adapter || !modelId) return 'New Chat';
        const { maxInputChars = 500, ...chatOpts } = options;
        const messages = this._buildTitleMessages(userMessage, systemPrompt, maxInputChars);
        if (!messages) return 'New Chat';
        try {
            const result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                maxTokens: 64,
                temperature: 0.3,
                budgetTokens: 0,           // Disable thinking — title gen is trivial
                reasoningEffort: 'none',   // Disable reasoning for OpenAI models too
                apiVersion: apiVersion || undefined,
                ...chatOpts,
            });
            return this._sanitiseTitle(result.content || '');
        } catch (e) {
            log.error('[LLMClient.generateTitle] inference failed:', e.message);
            return 'New Chat';
        }
    }

    /**
     * Generate a short title for a conversation. Resolves the provider the same
     * way the chat-tier path does (via _resolve → getProviderForModel +
     * getAdapter, now including apiVersion) and delegates to
     * generateTitleWithProvider, so a provider error returns 'New Chat' instead
     * of bubbling.
     */
    async generateTitle(modelId, userMessage, systemPrompt, options = {}) {
        let r;
        try {
            r = await this._resolve(modelId);
        } catch (e) {
            log.error('[LLMClient.generateTitle] provider resolution failed:', e.message);
            return 'New Chat';
        }
        return this.generateTitleWithProvider(
            { adapter: r.adapter, apiKey: r.apiKey, apiUrl: r.baseUrl, modelId: r.modelId || modelId, apiVersion: r.apiVersion },
            userMessage,
            systemPrompt,
            options,
        );
    }

    /**
     * Run a tool-calling loop: chat → check for tool calls → execute → repeat.
     * Returns { messages, content, toolCallRounds, structured, usage } — `usage`
     * is the SUM across every round (including the forced synthesis call), in
     * snake_case fields, so one usage row covers the whole loop.
     *
     * @param {string} modelId
     * @param {Array} messages - Initial messages
     * @param {Array} tools - Tool definitions (OpenAI format)
     * @param {object} options - Chat options. Optional `options.finalTool` (an
     *   OpenAI-format tool def) FORCES the synthesis/final call to call that tool
     *   instead of dropping tools / emitting prose. Applies on BOTH exit paths:
     *   the model stopping its tool calls, and the max-rounds-hit final chat. When
     *   set, the return value's `structured` is the parsed finalTool args (or null
     *   when the model declined / emitted unparseable args — output is untrusted).
     *   When omitted, behaviour is IDENTICAL to before: toolChoice:'auto' loop and
     *   a final chat with tools:undefined, and `structured` is null.
     * @param {function} executeTool - async (name, args) => result string
     * @param {number} maxRounds - Max tool call rounds (default: 5)
     */
    async runToolLoop(modelId, messages, tools, options = {}, executeTool, maxRounds = 5) {
        const { finalTool, ...chatOptions } = options;
        let rounds = 0;
        const updatedMessages = [...messages];

        // Cross-round usage accumulation. A tool loop is one logical model call
        // to its callers (usage logging, cost accounting), but N provider calls
        // under the hood — returning only the last round's usage under-bills
        // every round before it. Canonical snake_case; tolerates adapters that
        // report camelCase (the same dual-read usageEntry() does).
        const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
        const addUsage = (u) => {
            if (!u || typeof u !== 'object') return;
            const pick = (snake, camel) => {
                const v = u[snake] ?? u[camel];
                return Number.isFinite(Number(v)) ? Number(v) : 0;
            };
            usageTotals.prompt_tokens += pick('prompt_tokens', 'promptTokens');
            usageTotals.completion_tokens += pick('completion_tokens', 'completionTokens');
            usageTotals.total_tokens += pick('total_tokens', 'totalTokens');
            usageTotals.cached_tokens += pick('cached_tokens', 'cachedTokens');
            usageTotals.reasoning_tokens += pick('reasoning_tokens', 'reasoningTokens');
        };

        // Force the synthesis call to emit structured output via `finalTool`.
        // Reuses the same provider-aware forcing as chatForcedTool, so the
        // synthesis step yields parseable tool args on every provider.
        const runFinalSynthesis = async () => {
            const { adapter } = await this._resolve(modelId);
            const finalName = finalTool?.function?.name;
            const result = await this.chat(modelId, updatedMessages, {
                ...chatOptions,
                tools: [finalTool],
                toolChoice: forcedToolChoice(adapter, finalName),
            });
            addUsage(result?.usage);
            const extracted = extractForcedResult(result, finalName, { modelId });
            return {
                content: extracted.content,
                structured: extracted.structured,
            };
        };

        while (rounds < maxRounds) {
            const result = await this.chat(modelId, updatedMessages, {
                ...chatOptions,
                tools,
                toolChoice: 'auto',
            });
            addUsage(result?.usage);

            if (!result.toolCalls || result.toolCalls.length === 0) {
                // No tool calls — done. When a finalTool is requested, the model
                // "stopped" without producing structured output, so run one forced
                // synthesis call to extract it rather than returning prose.
                if (finalTool) {
                    const final = await runFinalSynthesis();
                    return {
                        messages: updatedMessages,
                        content: final.content,
                        toolCallRounds: rounds,
                        structured: final.structured,
                        usage: usageTotals,
                    };
                }
                return { messages: updatedMessages, content: result.content, toolCallRounds: rounds, structured: null, usage: usageTotals };
            }

            // Add assistant message with tool calls
            updatedMessages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });

            // Execute each tool call and add results
            for (const tc of result.toolCalls) {
                const fnName = tc.function?.name || tc.name;
                const fnArgs = tc.function?.arguments || tc.input;
                let args;
                try {
                    args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
                } catch {
                    args = {};
                }

                let toolResult;
                try {
                    toolResult = await executeTool(fnName, args);
                } catch (e) {
                    toolResult = `Error: ${e.message}`;
                }

                updatedMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                });
            }

            rounds++;
        }

        // Max rounds hit — synthesize a final answer. With a finalTool, force the
        // structured tool call; otherwise preserve the original behaviour of one
        // final chat with tools dropped.
        if (finalTool) {
            const final = await runFinalSynthesis();
            return {
                messages: updatedMessages,
                content: final.content,
                toolCallRounds: rounds,
                structured: final.structured,
                usage: usageTotals,
            };
        }
        const finalResult = await this.chat(modelId, updatedMessages, {
            ...chatOptions,
            tools: undefined,
        });
        addUsage(finalResult?.usage);
        return { messages: updatedMessages, content: finalResult.content, toolCallRounds: rounds, structured: null, usage: usageTotals };
    }
}

// Singleton
module.exports = new LLMClient();
// The pure helpers, for callers that already hold an adapter and for tests.
module.exports.forcedToolChoice = forcedToolChoice;
module.exports.parseToolCallArgs = parseToolCallArgs;
module.exports.extractForcedResult = extractForcedResult;
