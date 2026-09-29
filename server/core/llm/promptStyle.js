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

module.exports = { buildWritingStyleAddendum, WRITING_STYLE_ADDENDUM };
