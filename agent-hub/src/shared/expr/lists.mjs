// @typecheck strict
/**
 * List and pattern helpers of the expression language that came with the
 * list functions (map/filter/some/every live in the engine as special forms,
 * because their second argument is evaluated once per element). The plain
 * functions here join FUNCTIONS in functions.mjs, their docs join
 * EXPR_FUNCTIONS. Pure, null-safe, deterministic like the rest.
 */
import { assertTextSize } from './limits.mjs';
import { compiledRegex, expandReplacement } from './regex.mjs';
import { COLLECTION_FUNCTIONS } from './collections.mjs';

const hasOwn = (/** @type {unknown} */ o, /** @type {string} */ k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/**
 * The value under `key` (own property only), or undefined.
 * @param {unknown} el @param {string} key
 */
export function ownField(el, key) {
    return hasOwn(el, key) ? /** @type {Record<string, unknown>} */ (el)[key] : undefined;
}

/**
 * How unique() tells two values apart: scalars strictly (1 and "1" differ),
 * objects and lists by their JSON text.
 * @param {unknown} v
 */
function identityOf(v) {
    if (v !== null && typeof v === 'object') {
        try { return `o:${JSON.stringify(v)}`; } catch { return v; }
    }
    return v;
}

/**
 * unique(list, key?): the first occurrence of every value (or of every value
 * under key) in list order. Not a list gives an empty list.
 * @param {unknown} list @param {unknown} [key]
 */
export function uniqueOf(list, key) {
    if (!Array.isArray(list)) return [];
    const byKey = key != null && key !== '';
    const seen = new Set();
    const out = [];
    for (const el of list) {
        const id = identityOf(byKey ? ownField(el, String(key)) : el);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(el);
    }
    return out;
}

/**
 * regexMatch(text, pattern, flags?): true when the pattern occurs in text.
 * @param {unknown} text @param {unknown} pattern @param {unknown} [flags]
 */
export function regexMatchOf(text, pattern, flags) {
    if (text == null) return false;
    const s = typeof text === 'string' ? text : String(text); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- compiledRegex only accepts patterns checkRegexCall allowed (no nested or alternated repeats, no back-references), the server compiles them with RE2, and the text is capped by assertTextSize
    assertTextSize(s.length);
    return compiledRegex(pattern, flags).plain.test(s);
}

/**
 * The match and its groups out of a replace callback's arguments
 * (match, g1..gn, offset, input[, named groups]). RE2 passes null for an
 * unmatched group and always a groups object; the native engine undefined.
 * @param {unknown[]} args
 */
function matchParts(args) {
    let end = args.length;
    const last = args[end - 1];
    if (last !== null && typeof last === 'object') end -= 1;
    end -= 2; // offset, input
    const groups = /** @type {Array<string | undefined>} */ (args.slice(1, end).map((g) => (g == null ? undefined : String(g))));
    return { match: String(args[0]), groups };
}

/**
 * regexReplace(text, pattern, with, flags?): every match replaced; `with` may
 * use $& (the match), $1..$99 (a group) and $$ (a dollar).
 * @param {unknown} text @param {unknown} pattern @param {unknown} repl @param {unknown} [flags]
 */
export function regexReplaceOf(text, pattern, repl, flags) {
    if (text == null) return '';
    const s = typeof text === 'string' ? text : String(text);
    assertTextSize(s.length);
    const r = repl == null ? '' : String(repl);
    const re = compiledRegex(pattern, flags).global;
    re.lastIndex = 0;
    let grown = s.length;
    return s.replace(re, (/** @type {unknown[]} */ ...args) => {
        const { match, groups } = matchParts(args);
        const piece = expandReplacement(r, match, groups);
        grown += piece.length - match.length;
        assertTextSize(grown);
        return piece;
    });
}

/**
 * sum(list, field?): with a field, the own property of each item (a
 * non-numeric value counts 0). Before the field it was ignored, so
 * sum(rows, "amount") gave 0; it now gives the total.
 * @param {unknown} list @param {unknown} field @param {(x: unknown) => number | null} toNum
 */
export function sumOf(list, field, toNum) {
    if (!Array.isArray(list)) return 0;
    const k = field == null || field === '' ? null : String(field);
    return list.reduce((s, x) => s + (toNum(k == null ? x : ownField(x, k)) || 0), 0);
}

/**
 * The plain functions of this file, spread into FUNCTIONS. A regex pattern
 * and its flags are text literals checked at parse time (regex.mjs
 * checkRegexCall); compiledRegex checks again before it runs.
 */
export const LIST_FUNCTIONS = {
    unique: (/** @type {unknown} */ arr, /** @type {unknown} */ key) => uniqueOf(arr, key),
    regexMatch: (/** @type {unknown} */ text, /** @type {unknown} */ pattern, /** @type {unknown} */ flags) => regexMatchOf(text, pattern, flags),
    regexReplace: (/** @type {unknown} */ text, /** @type {unknown} */ pattern, /** @type {unknown} */ repl, /** @type {unknown} */ flags) => regexReplaceOf(text, pattern, repl, flags),
    ...COLLECTION_FUNCTIONS, // sort, reverse, slice, groupBy, keys, values, merge, range
};

/**
 * The list special forms: `name(list, expr)` with expr evaluated once per
 * item, which it reads as `it` (engine.mjs). Not in FUNCTIONS: they are not
 * plain calls of argument values.
 */
export const EACH_FUNCTIONS = /** @type {const} */ (['map', 'filter', 'some', 'every']);

/** The doc entries of the functions above and of the list special forms. */
export const LIST_FUNCTION_DOCS = [
    { name: 'unique', signature: 'unique(list, key?)', description: 'The list without repeats, first occurrence kept; with key, one item per value under key.' },
    { name: 'regexMatch', signature: 'regexMatch(text, "pattern", "flags"?)', description: 'True when the regular expression occurs in text. Pattern and flags (i, m, s) are written in quotes; no look-ahead/behind or back-references.' },
    { name: 'regexReplace', signature: 'regexReplace(text, "pattern", with, "flags"?)', description: 'Replace every match of the regular expression; with may use $& (the match), $1…$99 (a group) and $$.' },
    { name: 'map', signature: 'map(list, expr)', description: 'A new list: expr worked out for every item, which expr reads as it — map(rows, it.price * it.qty).' },
    { name: 'filter', signature: 'filter(list, expr)', description: 'The items for which expr (reading the item as it) is true — filter(rows, it.status == "open").' },
    { name: 'some', signature: 'some(list, expr)', description: 'True when expr (reading the item as it) is true for at least one item; false for an empty list.' },
    { name: 'every', signature: 'every(list, expr)', description: 'True when the list is not empty and expr (reading the item as it) is true for every item.' },
];
