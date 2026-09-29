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
 * @param {Array} msgs - Chat messages array
 * @returns {Array} Cleaned messages with only API-safe fields
 */
const log = require('../telemetry/log');
function sanitizeMessages(msgs) {
    return msgs.map(m => {
        const clean = { role: m.role, content: m.content };
        if (m.tool_calls) clean.tool_calls = m.tool_calls;
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
        const content = coerceWireContent(m.content, m.role);
        const needsStrip = INTERNAL_MESSAGE_FIELDS.some(f => f in m);
        if (!needsStrip && content === m.content) return m;
        const clean = { ...m, content };
        for (const f of INTERNAL_MESSAGE_FIELDS) delete clean[f];
        return clean;
    });
}

module.exports = {
    sanitizeMessages,
    stripInternalFields,
    coerceWireContent,
    INTERNAL_MESSAGE_FIELDS,
};
