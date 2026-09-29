// @typecheck
/**
 * Head-anchored history window for prefix-cached chat loops.
 *
 * WHY NOT `.slice(-N)`. A sliding tail keeps the LAST N messages, so every new
 * exchange shifts which message sits first — and the bytes of every message
 * after it move too. A prompt-prefix cache (llama.cpp's KV cache, OpenAI's
 * prefix cache, Anthropic's breakpoints) matches from the front, so a tail
 * window invalidates the whole history block on every single turn. Measured on
 * the demo box (single-slot llama.cpp, ~150 tok/s prompt processing): the
 * builder re-read ~22k tokens per user turn — about three minutes of prefill
 * before the first token — for a conversation that had changed by one exchange.
 *
 * This window is anchored at the HEAD instead. While the history fits the
 * budget nothing is dropped, so the windowed list only ever grows by appending
 * and the cached prefix survives intact. When it no longer fits, whole blocks
 * of `block` messages are evicted from the FRONT, so an eviction moves the
 * window start to the next block boundary — and it then stays put for as many
 * turns as the next block takes to fill. The cache is lost once per block, not
 * once per turn.
 *
 * Pure and deterministic: same input, same output — a requirement, because two
 * turns that compute different windows for the same history break the very
 * prefix this exists to keep.
 */

const { estimateTokens } = require('./tokenBudget');

// Six messages = three user/assistant exchanges. Small enough that an eviction
// does not wipe the model's short-term memory of the last thing it built,
// large enough that evictions are rare on a normal build session.
const HISTORY_EVICT_BLOCK = 6;

// Roughly 24k characters of prior conversation. Beyond this the live draft
// state (sent separately every turn) is the better memory of what was built.
const DEFAULT_HISTORY_BUDGET_TOKENS = 6000;

// Per-message overhead: role token + the template's turn delimiters. Four is
// the usual chat-template cost and keeps the estimate on the safe side.
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

function messageTokens(m) {
    const content = m && m.content;
    const text = typeof content === 'string'
        ? content
        : (content == null ? '' : JSON.stringify(content));
    return estimateTokens(text) + PER_MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Trim `messages` to fit `budgetTokens`, evicting from the head in multiples
 * of `block`. Never returns a list that opens with an assistant message: a
 * window that starts mid-exchange shows the model an answer without its
 * question, which reads as an instruction it never received.
 *
 * @param {Array<{role:string, content:*}>} messages  oldest first
 * @param {{budgetTokens?: number, block?: number}} [opts]
 * @returns {Array} a new array (the input is not mutated)
 */
function windowHistory(messages, { budgetTokens = DEFAULT_HISTORY_BUDGET_TOKENS, block = HISTORY_EVICT_BLOCK } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const step = Math.max(1, Math.floor(Number(block)) || HISTORY_EVICT_BLOCK);
    const budget = Number.isFinite(Number(budgetTokens)) ? Number(budgetTokens) : DEFAULT_HISTORY_BUDGET_TOKENS;

    const out = messages.slice();
    let total = 0;
    for (const m of out) total += messageTokens(m);

    while (total > budget && out.length > step) {
        const dropped = out.splice(0, step);
        for (const m of dropped) total -= messageTokens(m);
    }
    while (out.length && out[0] && out[0].role === 'assistant') out.shift();
    return out;
}

module.exports = { windowHistory, HISTORY_EVICT_BLOCK, DEFAULT_HISTORY_BUDGET_TOKENS };
