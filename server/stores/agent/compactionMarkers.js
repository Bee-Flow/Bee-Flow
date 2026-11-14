// @typecheck strict
/**
 * The synthetic priming turns core/llm/compaction.js injects, as named constants.
 *
 * These are PROMPT SCAFFOLDING, not conversation: the model never streamed the
 * two acknowledgements and the user never typed the two markers. They exist only
 * to keep user/assistant alternation valid across the compaction boundary.
 *
 * They live with the stores because the read-path normaliser
 * (normalizeStoredMessages.js) has to recognise them in already-persisted
 * conversations (BFSF-307, where the compacted PROMPT
 * was being written back as the durable history). A copy-pasted literal over
 * there would be a time bomb — reword a prompt and the filter silently
 * stops matching. Anything that recognises these MUST import them.
 *
 * `startsWith` for the markers (they are followed by the goal / summary text),
 * exact equality for the acknowledgements. Mind the characters: GOAL_ACK uses an
 * em-dash (U+2014), SUMMARY_ACK a straight apostrophe.
 */
const COMPACTION_MARKERS = Object.freeze({
    GOAL_PREFIX: '[Original request — treat this as the authoritative goal for the whole conversation; never ask the user to restate it]',
    GOAL_ACK: 'Understood — I will keep that original goal in mind.',
    SUMMARY_PREFIX: '[Conversation Summary — earlier messages have been compacted]',
    SUMMARY_PREFIX_NO_TEXT: '[Earlier messages have been compacted.',
    SUMMARY_ACK: 'Understood, I have the context from our earlier conversation. Let\'s continue.',
});

module.exports = { COMPACTION_MARKERS };
