// @typecheck
/**
 * Helpers for keeping a request's cacheable prefix byte-stable.
 *
 * Anthropic's prompt cache is a prefix match over `tools → system → messages`.
 * One changed byte anywhere in the prefix invalidates everything after it, and
 * a 1-hour breakpoint costs 2x on write — so a prefix that drifts every turn is
 * more expensive than not caching at all. These helpers exist so call sites can
 * assert and observe stability instead of assuming it.
 */

const crypto = require('crypto');

/**
 * Short, order-sensitive fingerprint of a tool list.
 *
 * Covers names AND their order: two turns whose tool sets are identical but
 * serialised in a different order still produce different prefixes, and this
 * is the cheapest way to see that in a log line or assert it in a test.
 *
 * @param {Array} tools OpenAI-shape tool definitions.
 * @returns {string} 12-char hex digest; `'none'` for an empty/absent list.
 */
function toolSetFingerprint(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return 'none';
    const names = tools.map(t => t?.function?.name || t?.name || '?').join(',');
    return crypto.createHash('sha256').update(names).digest('hex').slice(0, 12);
}

/**
 * Fingerprint of the tool list's BYTES — names, order, descriptions and
 * parameter schemas, exactly as serialised for the request.
 *
 * toolSetFingerprint answers "the same tools, in the same order"; two turns
 * can agree on that and still differ in what the model reads (a projected
 * schema variant, a description edit, an injected shared param), and on a
 * prefix cache the bytes are what count. Logged beside sys= so a session
 * whose tool bytes moved is visible without diffing 30 kB by hand.
 *
 * @param {Array} tools OpenAI-shape tool definitions.
 * @returns {string} 12-char hex digest; `'none'` for an empty/absent list.
 */
function toolBytesFingerprint(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return 'none';
    let bytes;
    try { bytes = JSON.stringify(tools); } catch (_) { return 'unserialisable'; }
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/**
 * Fingerprint of the cacheable system block.
 *
 * @param {string} text
 * @returns {string} 12-char hex digest; `'empty'` for empty/absent input.
 */
function systemPrefixFingerprint(text) {
    if (typeof text !== 'string' || text.length === 0) return 'empty';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

module.exports = { toolSetFingerprint, toolBytesFingerprint, systemPrefixFingerprint };
