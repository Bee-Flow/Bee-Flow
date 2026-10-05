// @typecheck
/**
 * Writing-style prompt addendum (BFSF-261, part b).
 *
 * Appended to every direct-chat and agent-chat system prompt (including
 * admin-custom and per-agent prompts — orgs reported the defaults, so the
 * layer is unconditional): proper sentence spacing, and em-dash avoidance —
 * hard rule for Dutch, where mid-sentence em-dashes read as machine
 * translation, softer for English.
 *
 * The string is a byte-stable module constant on purpose: both prompt
 * builders append it at a fixed position INSIDE the cacheable prefix, so
 * provider prompt caching keeps hitting (the same reason chatStream sorts
 * tools). This is steering, not a guarantee — no regex post-processing is
 * done on output (auto-inserting spaces would corrupt "v1.2", URLs and
 * file paths).
 */

const WRITING_STYLE_ADDENDUM = `

## Writing style
- Always put a space after sentence-ending punctuation. Never run sentences together like "word.Next".
- Avoid em-dashes (—) mid-sentence; prefer commas, colons, or parentheses. Use at most one where it is truly the clearest option.
- When responding in Dutch, never use em-dashes inside sentences — use natural Dutch punctuation (komma, dubbele punt, haakjes) instead.`;

function buildWritingStyleAddendum() {
    return WRITING_STYLE_ADDENDUM;
}

/**
 * The reply-language rule (BFSF-387), appended by both prompt builders right
 * after the style addendum, so an admin's custom direct-chat prompt or an
 * agent's own prompt can no longer drop it (agent chat never had one). A fixed
 * persona language is "the agent's own instructions" and still wins. Active
 * Memory rides a later, volatile block, often right next to the user's
 * message, so a remembered "language: Dutch" used to beat the old rule; the
 * last sentence takes that away. Byte-stable for the same caching reason.
 */
const RESPONSE_LANGUAGE_RULE = `

## Reply language
Reply in the language of the user's latest message. Switch only when the user asks for another language in this conversation, or when your own instructions fix a reply language. A language remembered in Active Memory never overrides the language of the user's latest message.`;

function buildResponseLanguageRule() {
    return RESPONSE_LANGUAGE_RULE;
}

module.exports = { buildWritingStyleAddendum, WRITING_STYLE_ADDENDUM, buildResponseLanguageRule, RESPONSE_LANGUAGE_RULE };
