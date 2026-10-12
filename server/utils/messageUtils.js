// @typecheck
/**
 * Message Utilities — shared helpers for chat message processing
 * 
 * Extracted from duplicate inline functions in agentRuntime.js
 * (chatWithAgent.sanitize and chatWithAgentStream.sanitize).
 */

/**
 * Sanitize chat messages before sending to LLM API.
 * Strips extra fields (parentId, id, kbSources, toolHistory, …) that providers
 * like Mistral reject.
 *
 * Preserves: role, content, tool_calls, tool_call_id, name, thinking.
 *
 * `thinking` is NOT wire data — it is the structured reasoning array the chat
 * runtimes persist, and provider adapters that support reasoning replay
 * (core/providers/claude.js → replayThinkingBlocks) rebuild their own content
 * blocks from it. Dropping it here is what made extended thinking vanish from
 * every multi-turn conversation: the adapter's replay path looked for
 * `m.thinking` on a message this function had already stripped it from, so the
 * model never saw a single earlier thought and its cached prefix changed shape
 * every turn.
 *
 * The two adapters that forward this array to the provider verbatim (OpenAI
 * chat-completions and Mistral) drop the field themselves — see their
 * `stripInternalFields` / normalizeMessages.
 *
 * `content` goes through `coerceWireContent`: the raw SSE path
 * (chatStream/rawSseStream.js) builds its request body from this output
 * directly, with no adapter `stripInternalFields` behind it, so an object
 * content revived from an old history row would 400 every later turn.
 *
 * @param {Array} msgs - Chat messages array
 * @returns {Array} Cleaned messages with only API-safe fields
 */
const log = require('../telemetry/log');
const { parseGemmaArgs } = require('../shared/looseToolArgs');

/**
 * Replace lone UTF-16 surrogates with U+FFFD. A lone surrogate serialises to
 * JSON that strict parsers (OpenAI: "Invalid body: failed to parse JSON
 * value", Anthropic) reject, bricking the whole request. Non-strings pass
 * through unchanged.
 */
function wellFormed(str) {
    if (typeof str !== 'string' || !str) return str;
    // ES2024: Node 22 has it, the typecheck's lib does not know it yet.
    const s = /** @type {string & { toWellFormed?: () => string }} */ (str);
    return typeof s.toWellFormed === 'function' ? s.toWellFormed() : str;
}

function isValidJson(str) {
    try { JSON.parse(str); return true; } catch (e) { return false; }
}

/**
 * Turn a tool call's `arguments` into a string that is valid JSON, whatever it
 * was stored as. Invalid strings are repaired with the loose parser when
 * possible, else replaced by '{}' (logged without content).
 */
function normalizeToolArguments(args) {
    if (args === undefined || args === null) return '{}';
    if (typeof args === 'string') {
        if (!args.trim()) return '{}';
        const fixed = wellFormed(args);
        if (isValidJson(fixed)) return fixed;
        let loose = null;
        try { loose = parseGemmaArgs(fixed); } catch (e) { loose = null; }
        if (loose && typeof loose === 'object') {
            log.warn('[MessageUtils] Repaired tool-call arguments that were not valid JSON');
            return wellFormed(JSON.stringify(loose));
        }
        log.warn('[MessageUtils] Replaced unparseable tool-call arguments with {}');
        return '{}';
    }
    try {
        const out = JSON.stringify(args);
        return out === undefined ? '{}' : wellFormed(out);
    } catch (e) {
        log.warn('[MessageUtils] Replaced unserialisable tool-call arguments with {}');
        return '{}';
    }
}

/** wellFormed over a string content or the `text` of content parts; identity when nothing changes. */
function wellFormedContent(content) {
    if (typeof content === 'string') return wellFormed(content);
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map(part => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
            const t = wellFormed(part.text);
            if (t !== part.text) { changed = true; return { ...part, text: t }; }
        }
        return part;
    });
    return changed ? out : content;
}

/** tool_calls with `function.arguments` normalised; identity when nothing changes. */
function normalizeToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return toolCalls;
    let changed = false;
    const out = toolCalls.map(tc => {
        if (!tc || typeof tc !== 'object' || !tc.function || typeof tc.function !== 'object') return tc;
        const args = normalizeToolArguments(tc.function.arguments);
        if (args === tc.function.arguments) return tc;
        changed = true;
        return { ...tc, function: { ...tc.function, arguments: args } };
    });
    return changed ? out : toolCalls;
}

/**
 * Diagnose what would make a request body unparseable. Returns indexes and
 * kinds only, never message content.
 * @returns {Array<{index:number, kind:'invalid_tool_args'|'lone_surrogate'|'object_content'}>}
 */
function findWireProblems(messages) {
    const problems = [];
    if (!Array.isArray(messages)) return problems;
    messages.forEach((m, index) => {
        if (!m || typeof m !== 'object') return;
        const c = m.content;
        if (c && typeof c === 'object' && !Array.isArray(c)) problems.push({ index, kind: 'object_content' });
        const wf = wellFormedContent(c);
        if (wf !== c) problems.push({ index, kind: 'lone_surrogate' });
        if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                const a = tc?.function?.arguments;
                if (typeof a === 'string' ? (a.trim() && !isValidJson(wellFormed(a))) || wellFormed(a) !== a : false) {
                    problems.push({ index, kind: 'invalid_tool_args' });
                    break;
                }
            }
        }
    });
    return problems;
}

function sanitizeMessages(msgs) {
    return msgs.map(m => {
        const clean = { role: m.role, content: wellFormedContent(coerceWireContent(m.content, m.role)) };
        if (m.tool_calls) clean.tool_calls = normalizeToolCalls(m.tool_calls);
        if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
        if (m.name) clean.name = m.name;
        if (m.thinking) clean.thinking = m.thinking;
        // Same reasoning as `thinking`: OpenAI's encrypted reasoning blocks have
        // to survive sanitisation to be replayed between tool rounds.
        if (m.reasoningItems) clean.reasoningItems = m.reasoningItems;
        return clean;
    });
}

/**
 * Coerce a message's `content` into a shape the OpenAI wire format accepts:
 * a string, an array of content blocks, or `null`.
 *
 * This is a LAST LINE OF DEFENCE, not the place a bad shape should be fixed.
 * The reason it exists: a single malformed message anywhere in a stored history
 * is replayed on every later turn, so the provider's 400 ("Invalid type for
 * 'messages[N].content': expected one of a string or array of objects, but got
 * an object instead") repeats forever and the user cannot get out of it — the
 * conversation is bricked and only deleting it helps. Losing the exact shape of
 * one odd message is a far smaller harm than that, so coerce and carry on.
 *
 * `null` is passed through: it is the wire-legal content of an assistant turn
 * that is nothing but `tool_calls`.
 */
function coerceWireContent(content, role) {
    if (typeof content === 'string' || content === null || content === undefined) return content;
    if (Array.isArray(content)) return content;
    let text;
    try { text = JSON.stringify(content); } catch (e) { text = String(content); }
    log.warn(`[MessageUtils] Coerced non-wire ${typeof content} content on a '${role || 'unknown'}' message to a string — this shape should have been fixed upstream`);
    return text;
}

/**
 * Drop the fields this codebase carries alongside a message that are not part
 * of the OpenAI wire format, and normalise `content` to a wire-legal shape. For
 * adapters that hand `messages` straight to a provider SDK; adapters that build
 * their own content blocks don't need it.
 */
// `reasoningItems` carries OpenAI's encrypted reasoning blocks between tool
// rounds in stateless mode (see providers/openai.js). Like `thinking`, it must
// survive sanitizeMessages so it can be replayed, and must be stripped here so
// it never reaches an adapter that forwards `messages` verbatim.
const INTERNAL_MESSAGE_FIELDS = ['thinking', 'attachments', 'kbSources', 'toolHistory', 'tokenisationInfo', 'reasoningItems'];

function stripInternalFields(msgs) {
    return msgs.map(m => {
        if (!m || typeof m !== 'object') return m;
        const content = wellFormedContent(coerceWireContent(m.content, m.role));
        const toolCalls = normalizeToolCalls(m.tool_calls);
        const needsStrip = INTERNAL_MESSAGE_FIELDS.some(f => f in m);
        if (!needsStrip && content === m.content && toolCalls === m.tool_calls) return m;
        const clean = { ...m, content };
        if (toolCalls !== undefined) clean.tool_calls = toolCalls;
        for (const f of INTERNAL_MESSAGE_FIELDS) delete clean[f];
        return clean;
    });
}

module.exports = {
    sanitizeMessages,
    stripInternalFields,
    coerceWireContent,
    wellFormed,
    wellFormedContent,
    normalizeToolArguments,
    findWireProblems,
    INTERNAL_MESSAGE_FIELDS,
};
