// @typecheck strict
/**
 * How a blocked attachment is written to the guardrail ledger.
 *
 * reason ∈ {pii, overflow, timeout, degraded, user_blocked, ask_timeout}.
 *  - overflow / timeout / degraded: the scan could not cover the input, so the
 *    content was withheld rather than judged -> 'held', `scan_<reason>`.
 *  - pii / user_blocked / ask_timeout: the scan worked and policy or the person
 *    decided -> 'blocked', with the detected categories kept. The human
 *    decisions add their reason as a separate comma-separated marker so an admin can tell a
 *    reviewed block (or an unanswered review) from an automatic one.
 */
const { encodeCategories } = require('../privacy/piiCategories');

const HELD_REASONS = new Set(['overflow', 'timeout', 'degraded']);

/**
 * @param {string} reason
 * @param {string[]} categories
 */
function attachmentBlockAudit(reason, categories) {
    const cause = reason && reason !== 'pii' ? reason : 'pii';
    if (HELD_REASONS.has(cause)) {
        return { cause, violation_categories: `scan_${cause}`, action_taken: 'held' };
    }
    // The reason is its own comma-separated marker, like scan_timeout: every
    // reader of violation_categories splits on ',' (a ' | ' join would fuse the
    // reason into the last category and hide a special category from the
    // withhold filter).
    const labels = [...(categories || []), ...(cause === 'pii' ? [] : [cause])];
    return { cause, violation_categories: encodeCategories(labels), action_taken: 'blocked' };
}

module.exports = { attachmentBlockAudit };
