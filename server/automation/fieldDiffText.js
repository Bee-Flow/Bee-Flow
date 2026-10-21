// @typecheck
'use strict';
/**
 * The full text of a long setting, for the line diff of two versions.
 *
 * fieldDiff() shortens every value to a one-line summary (140 characters). A
 * code step, a prompt or a message is read as text, so with
 * `fieldDiff(prev, next, { fullText: true })` a changed entry of such a setting
 * also carries
 *
 *   beforeText / afterText   the whole text, or null for a side that is not text
 *   textTruncated            true when a side was cut at the byte cap
 *
 * Text is a string, or a literal / template binding holding a string; a ref or
 * an expression is not text (its summary is already what it says). The entry
 * only gets the fields when at least one side is text.
 *
 * The cap is AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES per side (default 200 KB,
 * 0 = unlimited).
 */

const { envCap } = require('./mcpRunReadCaps');

/** The settings whose value is prose or code, not a pick or a number. */
const LONG_TEXT_SETTINGS = new Set([
    'code', 'prompt', 'instructions', 'systemPrompt', 'message', 'text', 'content', 'body', 'template', 'markdown', 'description',
]);

const maxBytes = () => envCap('AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES', 204800);

/** @param {any} v @returns {string|null} */
function textOf(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && (v.kind === 'literal' || v.kind === 'template') && typeof v.value === 'string') return v.value;
    return null;
}

/** @param {string} s @param {number} cap @returns {{ text: string, cut: boolean }} */
function capBytes(s, cap) {
    if (cap <= 0 || Buffer.byteLength(s, 'utf8') <= cap) return { text: s, cut: false };
    // Cut on a byte boundary, then drop a character the cut split in half.
    const text = Buffer.from(s, 'utf8').subarray(0, cap).toString('utf8').replace(/�+$/, '');
    return { text, cut: true };
}

/**
 * The extra fields of one changed entry, or {} when it has none.
 * @param {{ parts: string[], before: any, after: any }} d  a diffSettings result
 * @param {{ fullText?: boolean }} [opts]
 * @returns {{ beforeText?: string|null, afterText?: string|null, textTruncated?: true }}
 */
function fullTextFields(d, opts) {
    if (!opts || opts.fullText !== true) return {};
    const code = d.parts[d.parts.length - 1];
    if (!LONG_TEXT_SETTINGS.has(code)) return {};
    const b = textOf(d.before);
    const a = textOf(d.after);
    if (b === null && a === null) return {};
    const cap = maxBytes();
    const cb = b === null ? null : capBytes(b, cap);
    const ca = a === null ? null : capBytes(a, cap);
    return {
        beforeText: cb ? cb.text : null,
        afterText: ca ? ca.text : null,
        ...((cb && cb.cut) || (ca && ca.cut) ? { textTruncated: /** @type {const} */ (true) } : {}),
    };
}

module.exports = { LONG_TEXT_SETTINGS, fullTextFields, textOf };
