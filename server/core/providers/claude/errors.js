// @typecheck
/**
 * Claude adapter: recognising stop reasons and API rejections.
 *
 * Refusal / context-window detectors for a response, and the 400s the
 * adapter retries once (unverifiable thinking replay, unsupported forced
 * tool_choice, context-management beta). Split out of core/providers/claude.js.
 */

/**
 * Claude Opus 5 and the Fable/Mythos family run safety classifiers that can
 * DECLINE a request. This is not an error and does not throw: the API answers
 * HTTP 200 with `stop_reason: 'refusal'`, NO text content, and a structured
 * `stop_details` giving an open-set category.
 *
 * So code that reads content blocks without checking `stop_reason` first shows
 * the user a blank answer with no explanation — which is exactly what this
 * adapter did. `stop_details` is populated ONLY for a refusal and is null for
 * every other stop reason, so it must always be guarded before reading.
 */
const REFUSAL_CATEGORY_HINTS = {
    cyber: 'security or exploitation content',
    bio: 'biological or chemical risk content',
    reasoning_extraction: 'a request to reveal internal reasoning',
    frontier_llm: 'a request about frontier model internals',
};

function refusalMessage(response) {
    const details = response?.stop_details || null;
    const hint = (details && REFUSAL_CATEGORY_HINTS[details.category]) || null;
    const why = hint ? ` It was classified as ${hint}.` : '';
    const extra = details && details.explanation ? ` ${details.explanation}` : '';
    return `The model declined to answer this request.${why}${extra}`.trim();
}

/**
 * `model_context_window_exceeded` is a stop reason the API added in 2026: the
 * request simply did not fit. Worth distinguishing from a refusal and from a
 * plain `max_tokens` truncation, because the remedy is different (fold the
 * conversation, don\'t rephrase it).
 */
function isContextWindowStop(response) {
    return response?.stop_reason === 'model_context_window_exceeded';
}

/**
 * Anthropic rejects a replayed `thinking` block whose signature it cannot
 * verify — the usual cause is a conversation that changed model mid-thread, so
 * the stored signature was minted by a different model. The blocks are an
 * optimisation, never load-bearing, so the adapter drops them and retries once
 * rather than failing the user's turn.
 */
function isThinkingReplayRejection(err) {
    if (err?.status && err.status !== 400) return false;
    const body = JSON.stringify(err?.error || '') + (err?.message || '');
    if (!/thinking|signature/i.test(body)) return false;
    return /invalid|verif|unexpected|expected|does not match|mismatch/i.test(body);
}

/**
 * The 400 a model answers a forced `tool_choice` with when it no longer
 * supports one. Recognised so a model the catalog does not know yet still
 * gets its answer through the `auto` fallback instead of a failed request.
 */
function isForcedToolChoiceRejection(err) {
    if (err?.status && err.status !== 400) return false;
    const body = JSON.stringify(err?.error || '') + (err?.message || '');
    return /tool_choice/i.test(body) && /not supported/i.test(body);
}

function isContextManagementRejection(err) {
    const body = JSON.stringify(err?.error || '') + (err?.message || '');
    return /context[_-]?management/i.test(body);
}

module.exports = {
    REFUSAL_CATEGORY_HINTS,
    refusalMessage,
    isContextWindowStop,
    isThinkingReplayRejection,
    isForcedToolChoiceRejection,
    isContextManagementRejection,
};
