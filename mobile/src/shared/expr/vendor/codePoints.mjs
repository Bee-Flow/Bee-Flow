// @typecheck
/**
 * Text helpers that count Unicode code points, like len(): an emoji is one
 * character, and nothing here can cut a surrogate pair in half.
 */

import { MAX_PAD_WIDTH, assertTextSize } from './limits.mjs';

const clamp = (n, max) => Math.min(Math.max(Math.trunc(n) || 0, 0), max);

/** substring(): JS argument rules (clamped, swapped when start > end), counted in code points. */
export function substringCp(str, start, end) {
    const cps = Array.from(str);
    const a = clamp(start, cps.length);
    const b = end == null ? cps.length : clamp(end, cps.length);
    return cps.slice(Math.min(a, b), Math.max(a, b)).join('');
}

/**
 * padStart(): pad to `width` code points with `fill` (cut by code point); never truncates.
 * The width is clamped to MAX_PAD_WIDTH: the author chooses it, and the pad is built in
 * full, so an unbounded width would be an unbounded allocation on the shared thread.
 */
export function padStartCp(str, width, fill) {
    const cps = Array.from(str);
    const pad = Array.from(fill);
    const missing = clamp(width, MAX_PAD_WIDTH) - cps.length;
    if (!(missing > 0) || !pad.length) return str;
    return Array.from({ length: missing }, (_, i) => pad[i % pad.length]).join('') + str;
}

/**
 * Join `parts` with `sep` once the result is known to fit the text cap: the
 * functions that can grow a text (replace, concat, join) measure first.
 * @param {string[]} parts
 * @param {string} sep
 */
export function joinTexts(parts, sep) {
    let total = sep.length * Math.max(parts.length - 1, 0);
    for (const p of parts) total += p.length;
    assertTextSize(total);
    return parts.join(sep);
}

/** split(): an empty separator splits by code point; anything else is String#split. */
export function splitCp(str, sep) {
    return sep === '' ? Array.from(str) : str.split(sep);
}
