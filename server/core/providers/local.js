// @typecheck
/**
 * Local / self-hosted LLM Provider Adapter
 *
 * Covers every runtime a customer can run on their own hardware: Ollama, vLLM,
 * llama.cpp (llama-server), LM Studio, SGLang, LocalAI, TGI, Jan, KoboldCpp,
 * plus "any other OpenAI-compatible endpoint".
 *
 * All of them speak the OpenAI Chat Completions wire format, so the request /
 * SSE handling in BaseProvider already works — including the <think>…</think>
 * and `reasoning_content` handling OSS reasoning models need (BFSF-263). What
 * this adapter adds on top is the part that is NOT OpenAI-shaped:
 *
 *   · Discovery. `/v1/models` on a local runtime returns bare ids with no
 *     metadata. Ollama's native `/api/tags` + `/api/show` return the parameter
 *     size, quantisation and real capability flags, so for Ollama we use those
 *     and fall back to `/v1/models` if the native API isn't reachable.
 *   · Reasoning control. Ollama takes `think: true|'low'|'high'`; vLLM and
 *     SGLang take `chat_template_kwargs.enable_thinking`. Both are derived from
 *     the tier's `reasoningEffort` so the existing tier settings mean something
 *     on a local model instead of being silently dropped.
 *   · Keyless auth. Ollama/LM Studio ship without a key; vLLM and llama.cpp
 *     have an optional `--api-key`. Sending `Authorization: Bearer` with an
 *     empty value makes some servers 401, so the header is only set when a key
 *     is actually configured.
 *   · Local-model registration, so cost accounting bills these at €0 instead
 *     of falling through to modelCosts' unknown-model upper bound.
 *
 * Adding another runtime is a `flavor` entry here plus a LOCAL_RUNTIMES entry
 * in ./localModels — no changes anywhere else in the stack.
 */

const BaseProvider = require('./base');
const { LOCAL_RUNTIMES, describeLocalModel, rememberLocalContextWindow } = require('./localModels');
const { projectToolsForTemplate } = require('../llm/toolSchemaProjection');
const log = require('../../telemetry/log');

// Discovery is a handful of HTTP calls against a box that might not be up.
// Keep the ceilings low so an unreachable endpoint degrades to "0 models"
// quickly rather than stalling the admin UI.
const DISCOVERY_TIMEOUT_MS = 8000;
const DETAIL_TIMEOUT_MS = 4000;
// Ollama's /api/show is one request per model. Bound both the fan-out and the
// number of models we enrich so a box with 200 pulled models stays snappy.
const DETAIL_CONCURRENCY = 6;
const DETAIL_MAX_MODELS = 60;

/**
 * Capabilities a runtime REPORTED for a model id, from Ollama's /api/show.
 *
 * Discovery knows the truth ("does this exact build think?"); request building
 * only has a bare tag and would otherwise have to guess it from the name. A
 * fine-tune called `support-triage:latest` guesses to nothing, and a Qwen3
 * instruct-only build guesses WRONG. So discovery records what it learned and
 * request building reads it back.
 *
 * Keyed by model id alone: two endpoints serving the same tag are serving the
 * same weights, and buildRequestBody is not given the base URL. Empty until a
 * discovery pass has run (probe, the model picker, tier resolution), so the
 * name-pattern fallback stays the floor rather than the ceiling.
 */
const reportedCapabilities = new Map();
// Runtime detection results per API root (see _runtimeFor).
const runtimeByRoot = new Map();
const RUNTIME_PROBE_TIMEOUT_MS = 1500;
// `root model` pairs whose context window has been asked of llama-server once
// (see _learnContextWindow). A miss is cached too: one timeout, not one per
// turn.
const windowProbed = new Set();
const WINDOW_PROBED_MAX = 500;
// Tool names whose forced object tool_choice has already been narrowed on
// llama.cpp once — the warning is per name, not per request (see
// _forceToolChoiceForLlamacpp).
const narrowedToolChoiceWarned = new Set();
// llama-server's answer when the model's reply did not parse under the chat
// format's PEG parser (common/chat.cpp: "The model produced output that does
// not match the expected <format> format"). The whole generation is thrown
// away with an HTTP 500 — nothing of it reaches the client. Sampled output:
// the next attempt is a fresh draw, so one retry answers most of them.
const PEG_MISMATCH_RE = /does not match the expected [\w-]+ format/i;
const PEG_MISMATCH_RETRIES = 1;
// Room a thinking turn needs on top of its reasoning, so a truncated turn is
// at worst a short answer and never an EMPTY one. Same number claude.js uses
// for its legacy budget_tokens path.
const MIN_VISIBLE_TOKENS = 1024;
// What a reasoning pass costs when the caller named an effort but no budget.
// These runtimes do not report their reasoning cap — llama-server's is the
// server-wide --reasoning-budget flag, invisible over the API — so the ladder
// is an estimate, deliberately on the generous side: over-reserving costs a
// larger ceiling the model rarely reaches, under-reserving costs a dead turn.
const REASONING_RESERVE_BY_EFFORT = {
    minimal: 1024,
    low: 1024,
    medium: 2048,
    high: 4096,
    xhigh: 8192,
    max: 8192,
};
const REASONING_RESERVE_DEFAULT = REASONING_RESERVE_BY_EFFORT.medium;
const LLAMACPP_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const CAPABILITY_CACHE_MAX = 500;

function rememberCapabilities(modelId, capabilities) {
    if (!modelId || !Array.isArray(capabilities)) return;
    // Bounded: a long-lived server that has seen many runtimes should not grow
    // this map forever. Oldest-first eviction; re-discovery refills it.
    if (reportedCapabilities.size >= CAPABILITY_CACHE_MAX) {
        const oldest = reportedCapabilities.keys().next().value;
        reportedCapabilities.delete(oldest);
    }
    reportedCapabilities.set(modelId, capabilities);
}

/**
 * What an OpenAI-compatible runtime DECLARES about a model, in the vocabulary
 * `describeLocalModel` already understands.
 *
 * llama.cpp answers /v1/models with an `architecture` block naming the
 * modalities it actually serves:
 *
 *   { id: 'glm-ocr', architecture: { input_modalities: ['text','image'] } }
 *
 * `describeLocalModel` has always preferred a declaration over its family-name
 * guess — but only Ollama ever handed it one, because this path threw the
 * architecture block away and passed the bare id. So a runtime that told us the
 * truth was still answered with a guess, and `glm-ocr` (a name no regex knows)
 * came back text-only. Every `documentMode: 'images'` step against it then
 * failed `vision_required`: the model could see, and the platform said it could
 * not.
 *
 * Only ADDITIVE claims are read. A runtime that lists no modalities gets
 * `null`, which leaves the family guess in charge — silence is not a denial,
 * and reading it as one would turn every runtime that omits the block into a
 * fleet of text-only models.
 */
function declaredCapabilities(entry) {
    const arch = entry && typeof entry.architecture === 'object' ? entry.architecture : null;
    const input = Array.isArray(arch?.input_modalities) ? arch.input_modalities.map(String) : null;
    if (!input || !input.length) return null;
    const caps = [];
    if (input.includes('image')) caps.push('vision');
    if (input.includes('audio')) caps.push('audio');
    // Everything else stays with the family guess: modalities say what a model
    // can READ, never whether it can call tools or think.
    const guess = describeLocalModel(entry.id);
    if (guess.tools) caps.push('tools');
    if (guess.reasoning) caps.push('thinking');
    if (guess.embedding) caps.push('embedding');
    return caps;
}

/**
 * Fold system messages into the one shape every chat template accepts.
 *
 * Templates decide where a system message may sit, and some raise on any
 * that is not the single first message. Measured on the demo box
 * (2026-09-11, llama-server, Qwen3.8-27B): a system message after a user
 * turn is a hard 400 ("System message must be at the beginning"), and TWO
 * leading system messages hang the request until the client gives up. The
 * Qwen3.6 template that ran the day before tolerated both, which is how the
 * shape reached the demo box unnoticed — the builder "died instantly" with
 * no visible reason.
 *
 * Callers send these on purpose. The automation builder emits its per-turn
 * draft state as a second system message placed late, so Claude hoists it
 * behind the cached system block and OpenAI keeps the longest stable prefix
 * — real wins there, irrelevant here where the template is the only reader.
 * So this adapter folds:
 *   · a leading run of system messages → the FIRST stays, the rest are
 *     treated as late (below). Not merged: merging changed block 0 on the
 *     first turn of every chat, where the per-turn block still sits right
 *     behind the stable one, so turn 1 never shared a cached prefix with
 *     turn 2;
 *   · a later system message → prepended to the NEXT user message as a
 *     framed block. Into a user message, not as a standalone turn: templates
 *     that demand strict user/assistant alternation (Gemma, Mistral) reject
 *     an extra turn, while every template accepts a longer user message.
 *     When no user message follows, it becomes one.
 * A list that is already "one system message, first" passes through untouched.
 */
const LATE_SYSTEM_FRAME = '[Instructions from the system — not written by the user]';

function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(p => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : ''))
            .filter(Boolean)
            .join('\n');
    }
    return content == null ? '' : String(content);
}

function foldLateSystemMessages(messages) {
    if (!Array.isArray(messages) || messages.length < 2) return messages;
    const isSys = (m) => !!m && m.role === 'system';
    const sysCount = messages.reduce((n, m) => n + (isSys(m) ? 1 : 0), 0);
    if (sysCount === 0 || (sysCount === 1 && isSys(messages[0]))) return messages;

    const out = [];
    let i = 0;
    const lead = [];
    while (i < messages.length && isSys(messages[i])) lead.push(messages[i++]);
    // Exactly ONE system message leads. Any further leading system message
    // is treated like a late one and rides the first user turn — NOT merged
    // into the first. Merging was the original safety net, but it changed
    // block 0 on the first turn of every conversation (`[stable, volatile,
    // user]` is the shape prompt assembly produces before there is any
    // history), so turn 1 could never share a cached prefix with turn 2.
    // Folding forward keeps block 0 byte-identical from the first turn on
    // and still hands the template a single system message.
    if (lead.length >= 1) out.push(lead[0]);
    let pending = lead.slice(1).map(m => `${LATE_SYSTEM_FRAME}\n${contentText(m.content)}`);
    const flushAsUser = () => {
        if (pending.length) out.push({ role: 'user', content: pending.join('\n\n') });
        pending = [];
    };
    for (; i < messages.length; i++) {
        const m = messages[i];
        if (isSys(m)) { pending.push(`${LATE_SYSTEM_FRAME}\n${contentText(m.content)}`); continue; }
        if (pending.length && m && m.role === 'user') {
            const block = pending.join('\n\n');
            pending = [];
            if (Array.isArray(m.content)) {
                // Multimodal user turn: keep the parts, lead with the folded text.
                out.push({ ...m, content: [{ type: 'text', text: block }, ...m.content] });
            } else {
                out.push({ ...m, content: `${block}\n\n${contentText(m.content)}` });
            }
            continue;
        }
        flushAsUser();
        out.push(m);
    }
    flushAsUser();
    return out;
}

class LocalProvider extends BaseProvider {
    /**
     * @param {string} flavor - key into LOCAL_RUNTIMES ('ollama', 'vllm', …)
     */
    constructor(flavor = 'openai-compatible') {
        super(flavor);
        this.flavor = flavor;
        this.runtime = LOCAL_RUNTIMES[flavor] || LOCAL_RUNTIMES['openai-compatible'];
    }

    // ─── Auth ────────────────────────────────────────────────────────────────

    /**
     * Only send Authorization when a key exists. Ollama ignores the header,
     * LM Studio accepts anything, but a bare `Bearer ` (empty key) is rejected
     * outright by some gateways — and a keyless local box is the common case.
     */
    getHeaders(apiKey) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        return headers;
    }

    // ─── Request building ────────────────────────────────────────────────────

    /**
     * OpenAI body + the per-runtime knobs that carry tier settings across.
     *
     * `max_tokens` is deprecated upstream but is the field every one of these
     * runtimes actually reads, so BaseProvider's choice stands. On top we add:
     *   · top_k               — supported by all of them via extra body
     *   · keep_alive          — Ollama only; stops a model unloading between turns
     *   · think               — Ollama's reasoning switch
     *   · chat_template_kwargs.enable_thinking — vLLM / SGLang equivalent
     *   · reasoning_effort, reasoning_budget_tokens, cache_prompt,
     *     return_progress — llama-server only (see _isLlamacpp)
     * and, before the body is built, two things the chat template needs to
     * see in a shape it can render: the turn's earlier reasoning on the
     * assistant tool-call messages (_replayReasoning) and, for Gemma 4, tool
     * schemas without the keywords its template misrenders (_projectTools).
     */
    buildRequestBody(model, messages, options = {}) {
        const llamacpp = this._isLlamacpp(options);
        // Resolved FIRST: the reasoning replay below is gated on it, and
        // super() strips the `thinking` field the replay reads.
        const thinking = this._resolveThinking(options);

        const body = super.buildRequestBody(model, this._replayReasoning(messages, { thinking, llamacpp }), {
            ...options,
            tools: this._projectTools(model, options.tools),
        });
        // See foldLateSystemMessages: the chat template is the only reader
        // here, and some templates refuse any system message that is not the
        // single first one.
        body.messages = foldLateSystemMessages(body.messages);

        if (options.topK !== undefined) body.top_k = options.topK;
        if (options.topP !== undefined) body.top_p = options.topP;

        if (llamacpp) this._forceToolChoiceForLlamacpp(body);
        if (llamacpp && options.forcedTool) this._forcedToolAsJsonSchema(body, options.forcedTool);

        if (this.flavor === 'ollama') {
            // `think` is the NATIVE /api/chat field; the OpenAI-compatible
            // route we post to drops it silently, so the tier's Reasoning
            // Effort used to mean nothing here — including "None", which left
            // a thinking model burning its whole token budget on reasoning the
            // admin had explicitly switched off. `reasoning_effort` is the
            // field that route actually reads.
            //
            // It is also strict: `reasoning_effort` against a model without the
            // `thinking` capability is a hard 400 ("does not support
            // thinking"), which would break every request for a tier whose
            // effort outlived a switch to a non-reasoning model. Gate on the
            // same family metadata the tier UI hides the control on, so the two
            // always agree.
            if (thinking !== null && this.supportsReasoning(model)) {
                body.reasoning_effort = this._ollamaEffort(thinking);
            }
            if (options.keepAlive !== undefined) body.keep_alive = options.keepAlive;
        } else if (thinking !== null) {
            // vLLM / SGLang / llama.cpp pass unknown keys into the chat
            // template; `enable_thinking` is the convention Qwen3, GLM and the
            // DeepSeek distills use.
            body.chat_template_kwargs = {
                ...(body.chat_template_kwargs || {}),
                enable_thinking: thinking !== false,
            };
            // llama-server additionally reads `reasoning_effort` per request.
            // Measured on the demo box (Qwen3.6-35B-A3B, 2026-09-10): 'none'
            // switches thinking off exactly like enable_thinking:false, while
            // low/medium/high produced the same reasoning — Qwen3 templates do
            // not grade the level; gpt-oss ones do. Sent only when the runtime
            // is known to be llama.cpp (_runtimeFor) — an unknown field is a
            // 400 on a strict OpenAI-shaped server.
            if (llamacpp) {
                body.reasoning_effort = thinking === false ? "none" : this._llamacppEffort(options.reasoningEffort);
                // A per-request reasoning budget IS honoured by the fork on
                // the demo box (server-common.cpp reads `reasoning_budget_tokens`
                // and falls back to the server-wide --reasoning-budget flag);
                // an earlier note here claimed the opposite, measured on an
                // older build. Sent only while thinking is on — a budget next
                // to 'none' contradicts itself — and only when the caller set
                // one: a tier with no budget keeps the server's flag.
                const budget = options.budgetTokens;
                if (thinking !== false && typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
                    body.reasoning_budget_tokens = budget;
                }
            }
            // Thinking mode must not run greedy on the families that say so.
            // Qwen3 and DeepSeek-R1 both document ≥ 0.6 for reasoning ("greedy
            // decoding … endless repetitions"); the builder profiles send
            // 0.0-0.2 for stable tool-call JSON, which is right with thinking
            // OFF and wrong with it ON — on the demo box that combination
            // reasoned for 8192 tokens without converging. Same idea as
            // claude.js forcing temperature 1 under thinking. The floor is the
            // family's own number (localModels.thinkingMinTemperature): Gemma 4
            // publishes none and keeps the caller's value. extraBody is
            // re-applied below, so a caller who insists can still override.
            const floor = this._describe(model).thinkingMinTemperature;
            if (thinking !== false && typeof floor === 'number' && typeof body.temperature === 'number' && body.temperature < floor) {
                body.temperature = floor;
            }
        }

        // Ask for the trailing usage chunk. llama.cpp, vLLM, LM Studio and
        // Ollama's OpenAI route all honour `stream_options.include_usage`;
        // without it a streamed turn ends with no token counts and is logged
        // as 0/0 tokens — free, but it reads as a broken meter.
        if (body.stream) {
            body.stream_options = { include_usage: true, ...(body.stream_options || {}) };
        }

        if (llamacpp) {
            // Prompt-cache reuse is llama-server's default (--cache-prompt),
            // but a per-request `cache_prompt: true` is the documented way to
            // ask for it and costs nothing — insurance against a build or a
            // flag that turns the default off, on the one runtime where a
            // 51 s first-round prefill is what the cache saves. Deliberately
            // NOT `id_slot` or `n_keep`: pinning a slot serialises every
            // caller onto it, and n_keep is a context-shift knob, not a cache one.
            body.cache_prompt = true;
            // Prefill progress. llama-server answers `return_progress: true`
            // with extra streaming chunks carrying `prompt_progress: { total,
            // cache, processed, time_ms }` while it is still reading the
            // prompt — the only live measurement there is of a 200 s
            // first-round prefill, and what the builder's waiting card counts
            // down on. Meaningless without a stream, so tied to `body.stream`
            // exactly like stream_options.
            if (body.stream) body.return_progress = true;
        }

        // Reasoning tokens are spent from the SAME budget as the answer on
        // every one of these runtimes (llama.cpp counts them in n_predict;
        // Ollama and vLLM likewise), while a tier's maxTokens was sized for the
        // visible answer alone. A tier that thinks therefore truncates
        // mid-thought and returns content: '' with no tool_calls — which reads
        // to the caller as "the model refused", and no local path retries it.
        // Claude solves this in _buildSdkParams ("Ensure enough room for
        // thinking + answer"); same idea here.
        body.max_tokens = this._withReasoningHeadroom(body.max_tokens, thinking, options);

        // extraBody is applied last by super() only when present; re-apply so a
        // caller can always override anything we set above.
        if (options.extraBody) Object.assign(body, options.extraBody);
        return body;
    }

    /**
     * Is the server behind this request llama-server? Either the admin picked
     * the flavor, or chat()/stream() probed `/props` and threaded the answer
     * in as `_runtime` (see _runtimeFor). Every llama.cpp-only field in
     * buildRequestBody hangs off this one answer.
     */
    _isLlamacpp(options = {}) {
        return options._runtime === "llamacpp" || this.flavor === "llamacpp";
    }

    /**
     * llama-server reads `tool_choice` as a STRING (`auto | none | required`,
     * server-common.cpp) and answers the OpenAI object form
     * `{type:'function',function:{name}}` with a "Wrong type supplied" warning
     * and the default — auto. Every forced call on the demo box ran unforced
     * that way (253 router-journal warnings in three days). With a single tool
     * on the list, `required` IS "call that tool"; with several, the list is
     * narrowed to the named one so `required` still means what the caller
     * meant. Narrowing changes the rendered tool block and therefore the
     * cached prefix, hence one warning per tool name: a direct emitter that
     * forces a tool from a full menu should switch to a one-tool list.
     */
    _forceToolChoiceForLlamacpp(body) {
        const choice = body.tool_choice;
        if (!choice || typeof choice !== 'object') return;
        const name = (choice.function && choice.function.name) || choice.name;
        if (typeof name !== 'string' || !name) return;
        body.tool_choice = 'required';
        if (!Array.isArray(body.tools) || body.tools.length <= 1) return;
        const named = body.tools.filter(t => t && t.function && t.function.name === name);
        if (!named.length) return;                 // not on the list: leave the menu, the model picks
        body.tools = named;
        if (!narrowedToolChoiceWarned.has(name)) {
            narrowedToolChoiceWarned.add(name);
            log.warn(`[LocalProvider] llama.cpp takes no per-name tool_choice: narrowed ${body.tools.length === 1 ? 'the' : 'a'} ${name} request from a multi-tool list to that one tool + 'required' — send a single-tool list to keep the prompt prefix stable (warned once per tool)`);
        }
    }

    /**
     * A FORCED single-tool call on llama-server, answered as grammar-enforced
     * JSON instead of a native tool call.
     *
     * Measured 2026-09-18 on the demo box (Gemma 4, playbook design phase):
     * twice in one morning the model closed its `<|tool_call>…<tool_call|>`
     * and kept going (`)<tool_call|> {`, ``>```json``), once with a bracket
     * too many inside — and llama-server's PEG parser then discards the WHOLE
     * generation with a 500 ("does not match the expected peg-gemma4
     * format"). For a native tool call the grammar only shapes the envelope,
     * never the arguments (see toolSchemaProjection), so nothing prevents it.
     *
     * `response_format: json_schema` is the other route llama-server offers:
     * the tool's parameter schema becomes a GBNF grammar and every sampled
     * token has to fit it — no junk after the object, no unbalanced bracket,
     * no PEG parser in the way. The tool stays on the list so its declaration
     * (the field descriptions) is still rendered into the system turn, and
     * `tool_choice: 'none'` keeps the tool grammar out of the way (llama.cpp
     * refuses a grammar beside an active tool choice). The answer arrives as
     * plain JSON in `content`; llmClient.extractForcedResult reads it there.
     * Verified against the router with `tools` + `none` + `json_schema`:
     * clean JSON, 5 s, no 500.
     */
    _forcedToolAsJsonSchema(body, toolDef) {
        const fn = toolDef && toolDef.function;
        const schema = fn && fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null;
        if (!schema) return;
        const projected = this._projectTools(body.model, [toolDef]);
        body.tools = Array.isArray(projected) && projected.length ? projected : [toolDef];
        body.tool_choice = 'none';
        body.response_format = { type: 'json_schema', json_schema: { name: fn.name || 'response', schema } };
    }

    /**
     * Tool schemas as the model's chat template can render them (see
     * core/llm/toolSchemaProjection). Only the families whose template
     * misrenders JSON Schema get a projected COPY; every other model, and a
     * request without tools, gets the caller's list untouched — same
     * reference, so the cloud-style byte-stable prefix is unaffected.
     */
    _projectTools(model, tools) {
        if (!Array.isArray(tools) || !tools.length) return tools;
        return projectToolsForTemplate(tools, { family: this._describe(model).family });
    }

    /**
     * Put the turn's earlier reasoning back where the template reads it.
     *
     * The builders keep the model's unsigned thinking parts on the assistant
     * tool-call message (`thinking: [{ text }]`) when the adapter surfaces
     * raw reasoning. BaseProvider strips that internal field before the body
     * is built, and no OpenAI-shaped runtime knows it anyway — what
     * llama-server's Gemma 4 template DOES replay is `reasoning_content` on an
     * assistant message after the last user turn (measured 2026-09-17). So,
     * on llama.cpp and only while the current request thinks (a thinking-off
     * round must not carry thinking back in), every assistant message with
     * tool_calls AND thinking parts after the last user message gets its
     * reasoning joined into `reasoning_content` before super() sees it.
     *
     * Only after the last user message: reasoning from an earlier turn is
     * stale by the time the person has spoken again, and the Gemma template
     * gates its own replay on the same boundary. Signed and redacted parts
     * are Anthropic's and are never replayed here.
     */
    _replayReasoning(messages, { thinking, llamacpp }) {
        if (!llamacpp || thinking === false || !Array.isArray(messages)) return messages;
        let lastUser = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
        }
        let changed = false;
        const out = messages.map((m, idx) => {
            if (idx <= lastUser || !m || m.role !== 'assistant') return m;
            if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || !Array.isArray(m.thinking)) return m;
            if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m;
            const text = m.thinking
                .filter(p => p && typeof p.text === 'string' && p.text && !p.signature && !p.redacted)
                .map(p => p.text)
                .join('\n');
            if (!text) return m;
            changed = true;
            return { ...m, reasoning_content: text };
        });
        return changed ? out : messages;
    }

    /**
     * Raise a token ceiling so a thinking turn still has room to answer.
     *
     * A floor, never an inflation: a ceiling that is already comfortable is
     * returned untouched, so tiers stay exactly as configured and only the ones
     * that would truncate move. Kept off the `thinking === null` case on
     * purpose — there the caller expressed no preference, we send no switch,
     * and whether the server thinks at all is its own default to make.
     *
     * @param {number} maxTokens - the ceiling BaseProvider resolved
     * @param {boolean|string|null} thinking - _resolveThinking's answer
     * @param {object} options - the adapter options (budgetTokens, reasoningEffort)
     * @returns {number} the ceiling to send
     */
    _withReasoningHeadroom(maxTokens, thinking, options = {}) {
        if (!thinking) return maxTokens;
        if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return maxTokens;
        const budget = options.budgetTokens;
        const reserve = (typeof budget === 'number' && Number.isFinite(budget) && budget > 0)
            ? budget
            : (REASONING_RESERVE_BY_EFFORT[options.reasoningEffort] ?? REASONING_RESERVE_DEFAULT);
        return Math.max(maxTokens, reserve + MIN_VISIBLE_TOKENS);
    }

    /**
     * `_resolveThinking`'s answer as an OpenAI `reasoning_effort` value.
     *
     * Most Ollama models treat this as on/off — on qwen3 'low', 'medium' and
     * 'high' all produce identical output and only 'none' changes anything —
     * but gpt-oss does grade its levels, so pass the level through rather than
     * collapsing it to a boolean.
     */
    _ollamaEffort(thinking) {
        if (thinking === false) return 'none';
        return typeof thinking === 'string' ? thinking : 'medium';
    }

    /**
     * Map the tier's reasoningEffort onto a runtime-native thinking switch.
     * Returns null when the caller expressed no preference, so we send nothing
     * and the model's own default applies.
     *
     * @returns {boolean|string|null}
     */
    _resolveThinking(options) {
        const effort = options.reasoningEffort;
        // An explicit 0 budget (title generation, classification) means "no
        // thinking" on every other adapter — honour it here too.
        if (options.budgetTokens === 0) return false;
        if (effort === undefined || effort === null) return null;
        if (effort === 'none' || effort === false) return false;
        if (this.flavor !== 'ollama') return true;
        // Ollama takes named levels; 'minimal' has no equivalent, so it maps to
        // the lowest real level rather than switching thinking off entirely.
        if (effort === 'minimal' || effort === 'low') return 'low';
        if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high';
        if (effort === 'medium') return 'medium';
        return true;
    }

    // ─── Runtime detection ───────────────────────────────────────────────────

    /**
     * Which server is really behind a generic "OpenAI-compatible" URL.
     *
     * The flavor is what the admin PICKED; the runtime is what answers. The
     * demo box, for one, is configured as openai-compatible and is llama-server
     * in router mode. That matters for reasoning control: llama.cpp reads
     * `reasoning_effort` per request (none switches thinking off, a level is
     * handed to the chat template — gpt-oss grades it, Qwen3 does not), while
     * a strict OpenAI-shaped server might refuse the unknown field. So the
     * field is only sent when we KNOW it is llama.cpp: either the flavor says
     * so, or `/props` — an endpoint only llama-server has — answered with its
     * build info. Probed once per base URL; a miss is cached as well so an
     * unreachable box costs one timeout, not one per request.
     *
     * @returns {Promise<"ollama"|"llamacpp"|"other">}
     */
    async _runtimeFor(apiKey, baseUrl) {
        if (this.flavor === "ollama") return "ollama";
        if (this.flavor === "llamacpp") return "llamacpp";
        const root = this._root(baseUrl);
        if (runtimeByRoot.has(root)) return runtimeByRoot.get(root);
        /** @type {"ollama"|"llamacpp"|"other"} */
        let runtime = "other";
        try {
            const props = await this._getJson(`${root}/props`, this.getHeaders(apiKey), RUNTIME_PROBE_TIMEOUT_MS);
            if (props && (props.build_info !== undefined || props.chat_template !== undefined)) runtime = "llamacpp";
        } catch (_) { /* not llama-server, or not up — either way: send nothing extra */ }
        runtimeByRoot.set(root, runtime);
        return runtime;
    }

    /**
     * Ask llama-server how big a window `model` actually gets and record it
     * for the emergency fold (localModels.rememberLocalContextWindow). Only
     * llama-server answers `/props`; `?model=` picks the instance in router
     * mode and is ignored by a single-model server. `n_ctx` there is the
     * PER-SLOT window — with `--parallel 2` and `--ctx-size 32768` it says
     * 16384, which is exactly the number a request must stay under. Once
     * per (root, model), and never blocking a turn on failure: the fold
     * merely keeps its default until the next turn learns better.
     */
    async _learnContextWindow(apiKey, baseUrl, model, runtime) {
        if (runtime !== "llamacpp" || !model) return;
        const root = this._root(baseUrl);
        const key = `${root} ${model}`;
        if (windowProbed.has(key)) return;
        if (windowProbed.size >= WINDOW_PROBED_MAX) windowProbed.delete(windowProbed.values().next().value);
        windowProbed.add(key);
        try {
            const url = `${root}/props?model=${encodeURIComponent(model)}`;
            const props = await this._getJson(url, this.getHeaders(apiKey), RUNTIME_PROBE_TIMEOUT_MS);
            const nCtx = Number(props?.default_generation_settings?.n_ctx);
            if (Number.isFinite(nCtx) && nCtx > 0) {
                rememberLocalContextWindow(model, nCtx);
                log.info(`[LocalProvider] ${model} on ${root}: context window ${nCtx} tokens (per slot)`);
            }
        } catch (e) {
            log.warn(`[LocalProvider] could not read the context window of ${model} on ${root}: ${e.message}`);
        }
    }

    /**
     * The tier's effort as llama.cpp spells it. llama-server accepts the
     * OpenAI vocabulary plus 'xhigh'/'max' and forwards it to the template;
     * anything else falls back to the template default via 'medium'.
     */
    _llamacppEffort(effort) {
        return LLAMACPP_EFFORTS.has(effort) ? effort : "medium";
    }

    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const runtime = await this._runtimeFor(apiKey, baseUrl);
        await this._learnContextWindow(apiKey, baseUrl, model, runtime);
        const opts = { ...options, _runtime: runtime };
        // A reply llama-server could not parse is gone for good (see
        // PEG_MISMATCH_RE); it is sampled output, so the same request is
        // asked once more before the caller hears "the model could not be
        // reached". Non-streaming only: nothing has reached the client yet.
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await super.chat(apiKey, baseUrl, model, messages, opts);
            } catch (e) {
                if (runtime !== 'llamacpp' || attempt >= PEG_MISMATCH_RETRIES || !PEG_MISMATCH_RE.test(String(e && e.message))) throw e;
                log.warn(`[LocalProvider] llama-server discarded a ${model} reply it could not parse (${e.message.slice(0, 160)}) — retrying once`);
            }
        }
    }

    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const runtime = await this._runtimeFor(apiKey, baseUrl);
        await this._learnContextWindow(apiKey, baseUrl, model, runtime);
        return super.stream(apiKey, baseUrl, model, messages, { ...options, _runtime: runtime }, onEvent);
    }

    // ─── Capabilities ────────────────────────────────────────────────────────

    /**
     * What we know about a model, preferring what the runtime actually
     * reported over what its name suggests.
     */
    _describe(modelId) {
        const capabilities = reportedCapabilities.get(modelId) || null;
        return describeLocalModel(modelId, capabilities ? { capabilities } : undefined);
    }

    supportsReasoning(modelId) {
        return this._describe(modelId).reasoning;
    }

    supportsVision(modelId) {
        return this._describe(modelId).vision;
    }

    /**
     * A local runtime streams the model's own chain of thought, so the tier's
     * "Reasoning Summary" switch is ours to honour — see BaseProvider.
     */
    surfacesRawReasoning() {
        return true;
    }

    // ─── URL helpers ─────────────────────────────────────────────────────────

    /** Strip trailing slashes and a trailing `/v1` — the API root of the server. */
    _root(baseUrl) {
        return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    }

    /** The `/v1` base BaseProvider's chat/stream paths expect. */
    _v1(baseUrl) {
        return `${this._root(baseUrl)}/v1`;
    }

    /** @returns {Promise<any>} parsed JSON of whichever runtime answered */
    async _getJson(url, headers, timeoutMs) {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
        return res.json();
    }

    // ─── Discovery ───────────────────────────────────────────────────────────

    /**
     * List the models this runtime is serving.
     *
     * Ollama gets the native path (richer metadata, real capability flags);
     * everything else gets `/v1/models`.
     *
     * NOTE: this does NOT register the ids as local for cost purposes. That
     * decision belongs to the caller, which knows the provider's STORED type —
     * this adapter can also be reached by URL guess, and a mis-guess must not
     * silently zero out a paid endpoint's billing. See getModelsForProvider.
     *
     * Never throws — an unreachable box returns [] so the admin UI renders
     * "0 models" instead of an error page.
     *
     * @returns {Promise<Array<{id, name, cat, reasoning, vision, tools, embedding, local}>>}
     */
    async listModels(apiKey, baseUrl, _opts = {}) {
        const headers = this.getHeaders(apiKey);
        let models = [];

        if (this.runtime.nativeApi === 'ollama') {
            models = await this._listOllamaModels(headers, baseUrl);
        }
        if (!models.length) {
            models = await this._listOpenAiModels(headers, baseUrl);
        }

        return models;
    }

    /** Native Ollama discovery: /api/tags, enriched per-model via /api/show. */
    async _listOllamaModels(headers, baseUrl) {
        const root = this._root(baseUrl);
        let tags;
        try {
            tags = await this._getJson(`${root}/api/tags`, headers, DISCOVERY_TIMEOUT_MS);
        } catch (e) {
            log.warn(`[LocalProvider] Ollama /api/tags failed (${e.message}); falling back to /v1/models`);
            return [];
        }

        const entries = (tags?.models || []).map(m => ({
            id: m.model || m.name,
            parameterSize: m.details?.parameter_size || null,
            quantization: m.details?.quantization_level || null,
            sizeBytes: Number(m.size) || null,
        })).filter(m => m.id);

        // /api/show carries the capability array ('completion' | 'tools' |
        // 'vision' | 'thinking' | 'embedding') — the only trustworthy source
        // for whether a given tag can actually call tools or see images.
        const capabilities = await this._fetchOllamaCapabilities(root, headers, entries.slice(0, DETAIL_MAX_MODELS));

        return entries.map(e => {
            const caps = capabilities.get(e.id) || null;
            // Hand the runtime's own answer to request building, which sees
            // only the tag.
            rememberCapabilities(e.id, caps);
            return {
                ...describeLocalModel(e.id, {
                    parameterSize: e.parameterSize,
                    quantization: e.quantization,
                    capabilities: caps,
                }),
                sizeBytes: e.sizeBytes,
            };
        });
    }

    /**
     * Fan out /api/show over the pulled models with a bounded worker pool.
     * A model whose detail call fails simply keeps its pattern-guessed
     * capabilities — discovery must not fail because one tag is broken.
     */
    async _fetchOllamaCapabilities(root, headers, entries) {
        const out = new Map();
        let cursor = 0;
        const worker = async () => {
            while (cursor < entries.length) {
                const entry = entries[cursor++];
                try {
                    const res = await fetch(`${root}/api/show`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ model: entry.id }),
                        signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
                    });
                    if (!res.ok) continue;
                    const data = /** @type {{ capabilities?: string[] }} */ (await res.json());
                    if (Array.isArray(data?.capabilities)) out.set(entry.id, data.capabilities);
                } catch (_) { /* keep the pattern guess for this one */ }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(DETAIL_CONCURRENCY, entries.length) }, worker)
        );
        return out;
    }

    /** Generic OpenAI discovery — vLLM, llama.cpp, LM Studio, SGLang, … */
    async _listOpenAiModels(headers, baseUrl) {
        try {
            const data = await this._getJson(`${this._v1(baseUrl)}/models`, headers, DISCOVERY_TIMEOUT_MS);
            return (data?.data || [])
                .filter(m => typeof m?.id === 'string' && m.id)
                .map(m => {
                    // llama-server (router mode) lists each loaded model's
                    // per-slot window under meta.n_ctx; the others say nothing.
                    rememberLocalContextWindow(m.id, m.meta?.n_ctx);
                    const caps = declaredCapabilities(m);
                    if (caps) rememberCapabilities(m.id, caps);
                    return describeLocalModel(m.id, caps ? { capabilities: caps } : undefined);
                });
        } catch (e) {
            log.warn(`[LocalProvider] ${this.name} /v1/models failed: ${e.message}`);
            return [];
        }
    }

    // ─── Health ──────────────────────────────────────────────────────────────

    /**
     * Probe an endpoint and report what is running there. Used by the admin
     * "Test connection" button and by autodetection, so it answers the two
     * questions an admin actually has: is it up, and what can it serve?
     *
     * @returns {Promise<{ok: boolean, flavor: string, version: string|null, modelCount: number, models: Array, error: string|null}>}
     */
    async probe(apiKey, baseUrl) {
        const headers = this.getHeaders(apiKey);
        const result = { ok: false, flavor: this.flavor, version: null, modelCount: 0, models: [], error: null };

        if (this.runtime.nativeApi === 'ollama') {
            try {
                const v = await this._getJson(`${this._root(baseUrl)}/api/version`, headers, DETAIL_TIMEOUT_MS);
                result.version = v?.version || null;
            } catch (_) { /* version is decoration, not the health signal */ }
        }

        try {
            const models = await this.listModels(apiKey, baseUrl);
            result.ok = true;
            result.models = models;
            result.modelCount = models.length;
            // A reachable runtime with nothing loaded is a real, reportable
            // state (vLLM starting up, Ollama with no models pulled) — not an
            // error, but the UI needs to say so.
            if (!models.length) result.error = 'Reachable, but no models are being served yet.';
        } catch (e) {
            result.error = e.message;
        }
        return result;
    }

    /**
     * Pull a model into an Ollama runtime, streaming progress.
     * Only Ollama can do this; the other runtimes load models at process start.
     *
     * @param {function} onProgress - called with each native progress object
     */
    async pullModel(apiKey, baseUrl, model, onProgress) {
        if (!this.runtime.canPull) {
            throw new Error(`${this.runtime.label} cannot download models over the API — load the model when starting the server.`);
        }
        const res = await fetch(`${this._root(baseUrl)}/api/pull`, {
            method: 'POST',
            headers: this.getHeaders(apiKey),
            body: JSON.stringify({ model, stream: true }),
        });
        if (!res.ok) {
            throw new Error(`Ollama pull failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
        }

        // Ollama streams newline-delimited JSON, not SSE.
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.error) throw new Error(parsed.error);
                    onProgress?.(parsed);
                } catch (e) {
                    if (e instanceof SyntaxError) continue;
                    throw e;
                }
            }
        }
    }
}

// Test hook: discovery writes into a module-level cache that outlives any one
// adapter instance, so a suite exercising it needs a way back to a clean slate.
LocalProvider._resetCapabilityCache = () => reportedCapabilities.clear();

LocalProvider.foldLateSystemMessages = foldLateSystemMessages;
LocalProvider.LATE_SYSTEM_FRAME = LATE_SYSTEM_FRAME;

module.exports = LocalProvider;
