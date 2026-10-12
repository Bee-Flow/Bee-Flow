/**
 * Direct Chat — the adapter options every call of this turn is made with.
 *
 * Resolves the tier settings into one `chatOptions` object and decides
 * whether OpenAI Responses chaining may be used at all this turn. Sets
 * `turn.chatOptions` and may clear `turn.lastResponseId`. Moved verbatim out
 * of streamTurn.js.
 */

const { TIER_DEFAULTS } = require('../../../core/llm/modelResolver');
const log = require('../../../telemetry/log');

// Builder tools write whole files (html/css/js) inside a single
// `webpage_file_write` tool call. On the `fast` tier that's maxTokens=2048 —
// Anthropic stops mid-string and the file ships truncated, leaving the page
// broken. Bump the cap whenever the webpage builder tools are in the tool
// list, regardless of tier, so the AI has room for a realistic file in one
// tool call.
const WEBPAGE_BUILD_MIN_TOKENS = 16384;

function buildChatOptions(turn) {
    const tierSettings = turn.tiers[turn.resolvedTier] || {};
    const tierDefaults = TIER_DEFAULTS[turn.resolvedTier] || TIER_DEFAULTS['fast'];
    const isThinkingModel = turn.modelId.includes('magistral');
    const defaultMaxTokens = isThinkingModel ? 40960 : tierDefaults.maxTokens;
    const wantsWebpageBuilder = turn.directChatTools.some(t => t?.function?.name === 'webpage_file_write');
    const baseMaxTokens = tierSettings.maxTokens || defaultMaxTokens;
    const effectiveMaxTokens = wantsWebpageBuilder
        ? Math.max(baseMaxTokens, WEBPAGE_BUILD_MIN_TOKENS)
        : baseMaxTokens;

    // OpenAI Responses chaining must never hide file context: a chained
    // request sends only the last user message, so the hydrated
    // extractedText blocks from history are never transmitted — the file
    // then silently depends on opaque provider-side state (which every
    // tool-turn reset rebuilds from OUR local reconstruction). With any
    // attachment in play, force the full hydrated history: same behavior
    // as the Azure (store:false) path, which has always been correct.
    if (turn.lastResponseId) {
        const { shouldDisableResponsesChaining } = require('../../../core/conversation/historyMerge');
        const attachmentContext =
            turn.persistedAttachments.length > 0 ||
            (Array.isArray(turn.resolvedHistory) && turn.resolvedHistory.some(m => Array.isArray(m?.attachments) && m.attachments.length > 0));
        if (shouldDisableResponsesChaining({ clientHistoryProvided: turn.clientHistoryProvided, attachmentContext })) {
            log.info('[DirectChat] Attachment context — Responses chaining disabled for this turn');
            turn.lastResponseId = null;
        }
    }

    turn.chatOptions = {
        // Carried into every adapter.chat/adapter.stream call below (they
        // all spread chatOptions), so one listener above cancels the whole
        // turn — including the request in flight to the model.
        signal: turn.clientAbort.signal,
        maxTokens: effectiveMaxTokens,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        // Per-turn user choice from the composer takes priority over the tier default.
        // Accepts: 'none' (disabled), 'low', 'medium', 'high', 'xhigh', 'max'.
        reasoningEffort: turn.requestReasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
        reasoningSummary: tierSettings.reasoningSummary !== undefined ? tierSettings.reasoningSummary : (tierDefaults.reasoningSummary || false),
        budgetTokens: tierSettings.budgetTokens || undefined,
        // OpenAI Responses API chaining — skip re-uploading full history
        previousResponseId: turn.lastResponseId || undefined,
    };
}

module.exports = { buildChatOptions };
