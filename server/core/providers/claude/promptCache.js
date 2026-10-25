// @typecheck
/**
 * Claude adapter: the prompt-cache breakpoints on the normalised history.
 *
 * Split out of ClaudeProvider.normalizeMessages (core/providers/claude.js),
 * which calls it between building the Claude-shape messages and repairing
 * the tool pairs. Mutates `normalized` in place, exactly as before.
 */

/**
 * @param {Array<any>} normalized Claude-shape messages (mutated in place).
 */
function applyPromptCacheBreakpoints(normalized) {
    // ─── Prompt caching ──────────────────────────────────────────
    // Anthropic allows up to 4 cache_control breakpoints per request and
    // requires longer TTLs to appear earlier in the wire order. The
    // adapter already places one 1h breakpoint on the first system block
    // (extractSystem) which caches "tools + stable system" together.
    // Here we add up to three 5-min breakpoints further down the request:
    //
    //   (a) Immediately after the compaction summary block, if present.
    //       This lets Anthropic cache (tools + system + summary) as a
    //       durable prefix that stays stable across many turns, even as
    //       the recent-window messages keep changing.
    //
    //   (b) On the last genuine user text message. This creates a
    //       shorter-lived breakpoint so the next turn can still hit the
    //       cache for "system + tools + summary + full recent history".
    //       Skipped if the message already has a cache_control marker
    //       set upstream (e.g. directChat attaches one to the last file
    //       block so the document content gets cached).
    //
    //   (c) On the last tool_result in a multi-turn agent loop. Each
    //       extra round otherwise re-tokenises the full tool history at
    //       full price. Tool_result blocks DO support cache_control per
    //       Anthropic docs.
    //
    //   (d) On the PREVIOUS user turn, if a breakpoint is still free.
    //       Anthropic only looks back 20 content blocks from a breakpoint
    //       when hunting for an existing cache entry, so a single turn that
    //       appends more than 20 blocks (a fan-out of tool calls, a
    //       multi-page upload) pushes the previous write out of range and
    //       silently re-bills the whole prefix. A trailing breakpoint one
    //       turn back is a cache READ (free refresh), not a second write,
    //       and it is what the docs recommend for growing conversations.
    //
    // Total breakpoints used: 1 (system, 1h) + up to 3 (5-min) = 4 max,
    // exactly at the 4-breakpoint cap.
    //
    // All skipped for very short conversations (<4 messages) where
    // caching overhead isn't worth it.
    const hasCacheControl = (msg) => {
        if (!Array.isArray(msg.content)) return false;
        return msg.content.some(b => b && typeof b === 'object' && b.cache_control);
    };

    // Block types that accept `cache_control`. Marking the LAST of them —
    // not the last *text* block — is what puts attachments inside the
    // cached prefix: an uploaded PDF is pushed as `text` (extracted) +
    // `document` (the raw bytes), so a text-only search parked the
    // breakpoint before the expensive half and re-billed the document at
    // full price on every follow-up question.
    const CACHEABLE_BLOCK_TYPES = new Set([
        'text', 'image', 'document', 'tool_result', 'tool_use', 'search_result',
    ]);

    const markLastCacheableBlock = (msg) => {
        if (typeof msg.content === 'string' && msg.content.trim()) {
            msg.content = [{
                type: "text",
                text: msg.content,
                cache_control: { type: "ephemeral" },
            }];
            return true;
        }
        if (Array.isArray(msg.content) && msg.content.length > 0) {
            for (let j = msg.content.length - 1; j >= 0; j--) {
                if (CACHEABLE_BLOCK_TYPES.has(msg.content[j]?.type)) {
                    msg.content[j].cache_control = { type: "ephemeral" };
                    return true;
                }
            }
        }
        return false;
    };

    const markLastToolResultBlock = (msg) => {
        if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
        for (let j = msg.content.length - 1; j >= 0; j--) {
            if (msg.content[j].type === 'tool_result') {
                msg.content[j].cache_control = { type: "ephemeral" };
                return true;
            }
        }
        return false;
    };

    const isSummaryMessage = (msg) => {
        if (msg.role !== 'user') return false;
        const text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
                ? (msg.content.find(b => b.type === 'text')?.text || '')
                : '';
        return text.startsWith('[Conversation Summary');
    };

    if (normalized.length >= 4) {
        let breakpointsUsed = 0;
        const BREAKPOINT_BUDGET = 3; // (a) summary, (b) last-user, (c) last-tool_result, (d) previous-user

        // Count pre-existing markers (e.g. attachment caching set in directChat).
        for (const msg of normalized) {
            if (hasCacheControl(msg)) breakpointsUsed += 1;
        }

        // (a) Breakpoint on the summary message, if the compactor inserted one.
        const summaryIdx = normalized.findIndex(isSummaryMessage);
        if (summaryIdx >= 0 && !hasCacheControl(normalized[summaryIdx]) && breakpointsUsed < BREAKPOINT_BUDGET) {
            if (markLastCacheableBlock(normalized[summaryIdx])) breakpointsUsed += 1;
        }

        // (b) Breakpoint on the last genuine user text message — skipped
        //     if the message already carries a marker (attachment cache).
        if (breakpointsUsed < BREAKPOINT_BUDGET) {
            for (let i = normalized.length - 1; i >= 0; i--) {
                const msg = normalized[i];
                if (msg.role !== 'user') continue;
                if (i === summaryIdx) continue; // already marked above
                if (hasCacheControl(msg)) continue; // upstream already marked
                if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue;
                if (markLastCacheableBlock(msg)) { breakpointsUsed += 1; break; }
            }
        }

        // (c) Breakpoint on the latest tool_result, if any. Multi-turn
        //     agent loops re-send the full tool-call chain every round;
        //     caching the last tool_result lets the next iteration read
        //     the prior context at 10% cost.
        if (breakpointsUsed < BREAKPOINT_BUDGET) {
            for (let i = normalized.length - 1; i >= 0; i--) {
                const msg = normalized[i];
                if (msg.role !== 'user') continue;
                if (hasCacheControl(msg)) continue;
                if (!Array.isArray(msg.content) || !msg.content.some(b => b.type === 'tool_result')) continue;
                if (markLastToolResultBlock(msg)) { breakpointsUsed += 1; break; }
            }
        }

        // (d) Trailing breakpoint one user turn further back — keeps the
        //     previous write inside the 20-block lookback window. Only
        //     runs with budget to spare, and only when there is real
        //     history in front of it to cache.
        if (breakpointsUsed < BREAKPOINT_BUDGET) {
            let seenUserTurns = 0;
            for (let i = normalized.length - 1; i >= 2; i--) {
                const msg = normalized[i];
                if (msg.role !== 'user') continue;
                if (hasCacheControl(msg)) { seenUserTurns += 1; continue; }
                seenUserTurns += 1;
                if (seenUserTurns < 2) continue; // skip the current turn
                if (markLastCacheableBlock(msg)) { breakpointsUsed += 1; }
                break;
            }
        }
    }
}

module.exports = { applyPromptCacheBreakpoints };

/**
 * @typedef {{ type?: string, text?: string, cache_control?: { type: string } }} Block
 * @typedef {{ role?: string, content?: string | Block[] }} Msg
 */
