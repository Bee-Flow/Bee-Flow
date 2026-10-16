// @typecheck
/**
 * Text helpers that count Unicode code points, like len(): an emoji is one
 * character, and nothing here can cut a surrogate pair in half.
 */

const clamp = (n, max) => Math.min(Math.max(Math.trunc(n) || 0, 0), max);

/** substring(): JS argument rules (clamped, swapped when start > end), counted in code points. */
export function substringCp(str, start, end) {
    const cps = Array.from(str);
    const a = clamp(start, cps.length);
    const b = end == null ? cps.length : clamp(end, cps.length);
    return cps.slice(Math.min(a, b), Math.max(a, b)).join('');
}

/** padStart(): pad to `width` code points with `fill` (cut by code point); never truncates. */
export function padStartCp(str, width, fill) {
    const cps = Array.from(str);
    const pad = Array.from(fill);
    const missing = Math.trunc(width) - cps.length;
    if (!(missing > 0) || !pad.length) return str;
    return Array.from({ length: missing }, (_, i) => pad[i % pad.length]).join('') + str;
}

/** split(): an empty separator splits by code point; anything else is String#split. */
export function splitCp(str, sep) {
    return sep === '' ? Array.from(str) : str.split(sep);
}
