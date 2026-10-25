// @typecheck
/**
 * Claude adapter: message-array repair before a request goes out.
 *
 * Pure functions over Anthropic-shape messages, split out of
 * core/providers/claude.js (which still owns normalisation and calls them).
 */

/**
 * Drop orphan tool_use/tool_result blocks so Anthropic doesn't reject the
 * request. After compaction or aggressive history pruning, the message array
 * can contain a `tool_result` whose matching `tool_use` has been summarised
 * away — Claude returns "unexpected tool_use_id found in tool_result blocks".
 *
 * Rules enforced (mirrors the API's contract):
 *   1. tool_result.tool_use_id must reference a tool_use emitted in the
 *      immediately previous assistant message.
 *   2. Every tool_use must have a matching tool_result in the immediately
 *      following user message.
 *
 * Anything that violates either rule is dropped. Messages that become empty
 * after dropping orphans are removed from the array entirely.
 */
/**
 * Merge runs of consecutive user messages that each carry tool_result blocks
 * into ONE user message. Anthropic requires every tool_result answering an
 * assistant turn's tool_use blocks to arrive in the SINGLE user message
 * immediately following that turn. Our tool loops (builder, chat, flowlet)
 * push one role:'tool' message per result, which normalizes to N consecutive
 * user messages on a parallel-tool-call round — without this merge,
 * repairToolPairs pairs only the FIRST result with the assistant turn and
 * silently drops the rest (the model then loses those results entirely).
 * Plain-text user messages are never merged — only tool_result carriers.
 */
function mergeToolResultRuns(messages) {
    const out = [];
    const carriesToolResult = (m) => m && m.role === 'user'
        && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result');
    for (const msg of messages) {
        const prev = out[out.length - 1];
        if (carriesToolResult(msg) && carriesToolResult(prev)) {
            prev.content = [...prev.content, ...msg.content];
            continue;
        }
        out.push(msg);
    }
    return out;
}

function repairToolPairs(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // user/tool_result message — keep only tool_result blocks whose id
        // appears in the previous assistant's tool_use blocks.
        if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_result')) {
            const prev = out[out.length - 1];
            const prevToolUseIds = new Set(
                (prev?.role === 'assistant' && Array.isArray(prev.content)
                    ? prev.content.filter(b => b?.type === 'tool_use').map(b => b.id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_result') return true; // keep non-tool blocks (rare but legal)
                return prevToolUseIds.has(b.tool_use_id);
            });
            if (cleaned.length === 0) continue; // entire message was orphaned — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        // assistant message with tool_use blocks — drop any tool_use whose
        // matching tool_result isn't in the next message. If all tool_uses
        // are orphaned and no other content remains, drop the message.
        if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_use')) {
            const next = messages[i + 1];
            const nextResultIds = new Set(
                (next?.role === 'user' && Array.isArray(next.content)
                    ? next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_use') return true;
                return nextResultIds.has(b.id);
            });
            const hasMeaningful = cleaned.some(b => b?.type === 'text' || b?.type === 'tool_use' || b?.type === 'thinking');
            if (!hasMeaningful) continue; // assistant turn was nothing but orphan tool_uses — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        out.push(msg);
    }
    return out;
}

module.exports = { mergeToolResultRuns, repairToolPairs };

/**
 * @typedef {{ type?: string, id?: string, tool_use_id?: string }} Block
 * @typedef {{ role?: string, content?: string | Block[], [k: string]: unknown }} Msg
 */
