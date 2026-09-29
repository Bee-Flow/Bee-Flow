// @typecheck
/**
 * Where the per-turn ("volatile") system block sits in the message list.
 *
 * Prompt assembly builds `[stable, volatile, …history, user]`: the stable
 * block is the byte-identical identity/tools/skills prompt every provider
 * caches, the volatile block is the clock, retrieved memories, per-query KB
 * chunks and the addenda a turn picks up on the way (PII tokens, moderation
 * flags, step-machine guards). Indices 0/1 are load-bearing during assembly —
 * compaction hoists system messages in order and half a dozen checks read
 * `messages[0].role === 'system'` — so the block is MOVED, not built, late.
 *
 * Why move it at all: a self-hosted llama.cpp server caches the prompt as a
 * byte prefix. With the volatile block second, every byte after it — the
 * whole history — is re-read on every turn (measured 2026-09-11 on this box:
 * 4,375 tokens / 28.7 s per turn with 1.5k system + 1.5k history). With the
 * block folded into the LAST user message, the stable prompt AND the history
 * are a cache hit and only ~56-75 tokens (~1 s) are re-read.
 *
 * The hosted adapters are indifferent to the position: Claude's extractSystem
 * collects every system message in order (block 0 keeps its breakpoint),
 * Google folds them into systemInstruction, OpenAI/Azure accept a system or
 * developer item anywhere, Mistral's API aggregates system prompts. The local
 * adapter folds a late system message into the following user turn
 * (local.js foldLateSystemMessages) because strict chat templates reject a
 * non-leading system role — which is also why Scaleway (vLLM with the
 * models' own templates, Gemma among them, and no fold) is NOT in the safe set.
 */

const LATE_SYSTEM_SAFE_TYPES = new Set(['claude', 'google', 'google-vertex', 'openai', 'azure', 'mistral']);

/**
 * May the volatile block be placed after the history for this provider?
 *
 * @param {string} providerType stored provider type
 * @param {{ isLocal?: boolean }} [opts] true when the request goes through the
 *   local adapter (which folds the block itself) — decided by the caller from
 *   the stored type AND the adapter instance, since a URL-guessed adapter has
 *   no stored type.
 */
function supportsLateSystemBlock(providerType, { isLocal = false } = {}) {
    return !!isLocal || LATE_SYSTEM_SAFE_TYPES.has(String(providerType || '').toLowerCase());
}

/**
 * Move `volatileMessage` to sit immediately before the LAST user message.
 *
 * In place, by reference, idempotent: calling it again after tool rounds
 * were appended leaves the block where it is (the last user message is still
 * the current turn's), so a caller can re-run it defensively. Appends when
 * there is no user message at all — a system-only list has nothing to fold
 * into, and the local adapter turns a trailing system message into its own
 * user turn.
 *
 * @param {Array<object>} messages
 * @param {object} volatileMessage the exact object placed at index 1 during
 *   assembly; absent from the list is fine (it is inserted, not duplicated)
 * @returns {Array<object>} the same array
 */
function placeVolatileBlock(messages, volatileMessage) {
    if (!Array.isArray(messages) || !volatileMessage) return messages;
    const at = messages.indexOf(volatileMessage);
    if (at !== -1) messages.splice(at, 1);
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
    }
    if (lastUser === -1) messages.push(volatileMessage);
    else messages.splice(lastUser, 0, volatileMessage);
    return messages;
}

/**
 * The inverse: put the block back at index 1, right after the stable block.
 *
 * For a provider outside the safe set — or after a mid-turn adapter swap to
 * one — the assembly-time shape `[stable, volatile, …]` is the one every
 * adapter already handled before this module existed. Same in-place,
 * by-reference, idempotent contract as placeVolatileBlock.
 */
function hoistVolatileBlock(messages, volatileMessage) {
    if (!Array.isArray(messages) || !volatileMessage) return messages;
    const at = messages.indexOf(volatileMessage);
    if (at !== -1) messages.splice(at, 1);
    const afterStable = (messages[0] && messages[0].role === 'system') ? 1 : 0;
    messages.splice(afterStable, 0, volatileMessage);
    return messages;
}

module.exports = { placeVolatileBlock, hoistVolatileBlock, supportsLateSystemBlock, LATE_SYSTEM_SAFE_TYPES };
