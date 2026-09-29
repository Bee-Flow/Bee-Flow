/**
 * What an assistant turn in the webpage chat actually DID — read off the tool
 * events the turn produced, never guessed from its prose (plan W2).
 *
 * `msg.toolHistory` is written by useChatEngine/sseEvents.js from the
 * `tool_start` / `tool_end` stream: `{ name, args, status, startTime,
 * endTime }`. That is the only trustworthy record of a turn's actions — the
 * assistant's own sentence ("I've connected your Orders table") is text a
 * model produced and may be wrong, so nothing here reads it.
 *
 * Two facts are derived, and both refuse to overclaim:
 *
 *   LINKS ADDED  Only a tool that COMPLETED counts. A grant that is still
 *                running, or that failed, added nothing — and a card saying
 *                "LINK ADDED" over a failed grant would send an author
 *                looking for a connection that is not there.
 *                Reads are not links: `webpage_db_query` and
 *                `webpage_db_schema` look at the page's own table without
 *                connecting anything, so only the writing table tool counts
 *                alongside the three `webpage_grant_*` tools.
 *
 *   STEPS + TIME Counted over completed tools, and the duration is null
 *                unless every counted step has both timestamps. A partial sum
 *                printed as "· 0.4s" would understate the work by an unknown
 *                amount; saying nothing is the honest alternative.
 *
 * A leaf module: no React, no fetch. Pure functions over one message object,
 * so the card that renders them and the tests that pin them share one truth.
 */

/** The three tools that write a bridge grant (server/integrations/webpageBridgeTools.js). */
export const GRANT_TOOL_RX = /^webpage_grant_[a-z]+$/;

/**
 * Table tools that CONNECT something. `webpage_db_exec` creates or alters the
 * page's tables; the other two only read, and a read is not a link.
 */
export const TABLE_LINK_TOOLS = Object.freeze(['webpage_db_exec']);

/** Tools that never represent work worth showing (the model thinking aloud). */
const HIDDEN_TOOLS = new Set(['sequentialthinking']);

function completedTools(msg) {
    const history = Array.isArray(msg?.toolHistory) ? msg.toolHistory : [];
    return history.filter(t => t && t.status === 'done' && !HIDDEN_TOOLS.has(t.name));
}

/** Is this tool name one that adds a link? */
export function isLinkTool(name) {
    if (typeof name !== 'string') return false;
    return GRANT_TOOL_RX.test(name) || TABLE_LINK_TOOLS.includes(name);
}

/**
 * The distinct link-adding tools this turn completed, in the order they ran.
 * Returns [] when the turn added none — the card is then not rendered at all.
 */
export function linksAddedIn(msg) {
    const seen = new Set();
    const out = [];
    for (const tool of completedTools(msg)) {
        if (!isLinkTool(tool.name) || seen.has(tool.name)) continue;
        seen.add(tool.name);
        out.push({ name: tool.name, args: tool.args || null });
    }
    return out;
}

/**
 * `{ steps, seconds }` for the "How I did this" line, or null when the turn
 * ran no visible tool. `seconds` is null when any counted step lacks a
 * timestamp — the count is still true, the duration would not be.
 */
export function stepSummary(msg) {
    const tools = completedTools(msg);
    if (tools.length === 0) return null;
    let total = 0;
    let timed = true;
    for (const t of tools) {
        if (typeof t.startTime !== 'number' || typeof t.endTime !== 'number' || t.endTime < t.startTime) {
            timed = false;
            break;
        }
        total += t.endTime - t.startTime;
    }
    return { steps: tools.length, seconds: timed ? total / 1000 : null };
}
