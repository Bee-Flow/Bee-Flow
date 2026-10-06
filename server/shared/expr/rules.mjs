/**
 * Rule logic of the Condition node — the ONE copy the runtime (server), the
 * builder (agent-hub, generated mirror) and the phone (mobile vendor copy)
 * share, so a rule reads, previews and runs the same everywhere.
 *
 *   - the scalar text tests behind contains/startsWith/endsWith/isEmpty, and
 *     `equals` (text ignores upper/lower case and surrounding spaces);
 *   - quantifiers over a list (`anyOf/everyOf/noneOf(list, "<test>", value)`):
 *     an explicit "any / every / no attachment" instead of comparing a whole
 *     list as one text;
 *   - File type: pdf, word, excel, … from a MIME type with the file name's
 *     extension as fallback (Gmail often sends application/octet-stream);
 *   - the text helpers both platforms' rule rows parse and write with, and
 *     (ruleFields.mjs) their field menu.
 *
 * Pure and dependency-free apart from ./path.mjs. No regex runs on rule text
 * or data here: string methods only, so nothing in it can backtrack.
 */

import { parsePath, formatPath, parseJsonText, isIdentifierKey } from './path.mjs';
import { fileTypeField, isDigit, isPlainObject } from './fileTypes.mjs';

export { FILE_TYPE_KEYS, fileTypeOf, isFileRecord, fileTypesNamedIn, fileTypeField } from './fileTypes.mjs';
export { ruleFieldOptions } from './ruleFields.mjs';

// ── Splitting rule text ──────────────────────────────────────────────────

/**
 * Split an expression on top-level `&&` or `||` (outside strings/parens).
 * Returns `{ parts, join }`, or null if BOTH joiners appear at top level
 * (mixed precedence — too ambiguous for the clickable UI).
 */
export function splitTopLevel(expr) {
    const parts = [];
    let depth = 0;
    let str = null;
    let buf = '';
    let join = null;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (str) {
            buf += c;
            if (c === '\\' && i + 1 < expr.length) { buf += expr[i + 1]; i++; continue; }
            if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'") { str = c; buf += c; continue; }
        if (c === '(' || c === '[') { depth++; buf += c; continue; }
        if (c === ')' || c === ']') { depth--; buf += c; continue; }
        const two = expr.slice(i, i + 2);
        if (depth === 0 && (two === '&&' || two === '||')) {
            if (join && join !== two) return null; // mixed && and || at top level
            join = two;
            parts.push(buf.trim());
            buf = '';
            i++; // skip 2nd char
            continue;
        }
        buf += c;
    }
    if (str || depth !== 0) return null; // unbalanced
    parts.push(buf.trim());
    return { parts: parts.filter((p) => p.length), join: join || '&&' };
}

/**
 * The arguments of a call from `from` (just past its `(`) up to the call's
 * own `)`: `{ args, end }` with `end` the index of that `)`, or null when it
 * never closes. Splits on top-level commas only, outside strings, brackets
 * and parens, so `headers[name="a,b"]` or a text "a, b" stays one argument.
 */
export function splitCallArgs(text, from) {
    const args = [];
    let depth = 0;
    let str = null;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
        if (c === '"' || c === "'") str = c;
        else if (c === '(' || c === '[') depth++;
        else if (depth > 0 && (c === ')' || c === ']')) depth--;
        else if (depth === 0 && c === ',') { args.push(text.slice(from, i).trim()); from = i + 1; }
        else if (c === ')') return { args: [...args, text.slice(from, i).trim()], end: i };
    }
    return null;
}

/** Index of the first `sym` outside strings, parens and brackets; -1 when none. */
export function findTopLevelSymbol(text, sym) {
    let depth = 0;
    let str = null;
    for (let i = 0; i <= text.length - sym.length; i++) {
        const c = text[i];
        if (str) { if (c === '\\') { i++; continue; } if (c === str) str = null; continue; }
        if (c === '"' || c === "'") { str = c; continue; }
        if (c === '(' || c === '[') { depth++; continue; }
        if (c === ')' || c === ']') { depth--; continue; }
        if (depth === 0 && text.slice(i, i + sym.length) === sym) return i;
    }
    return -1;
}

// ── Scalar tests ─────────────────────────────────────────────────────────
// Text matching ignores upper/lower case (see functions.mjs, where these are
// the bodies of contains/startsWith/endsWith/isEmpty).

const ci = (x) => String(x).toLowerCase();

export function textContains(a, b) {
    return a == null ? false : ci(a).includes(b == null ? '' : ci(b));
}

export function textStartsWith(a, b) {
    return a == null ? false : ci(a).startsWith(b == null ? '' : ci(b));
}

export function textEndsWith(a, b) {
    return a == null ? false : ci(a).endsWith(b == null ? '' : ci(b));
}

export function isEmptyValue(a) {
    if (a == null) return true;
    if (Array.isArray(a) || typeof a === 'string') return a.length === 0;
    if (typeof a === 'object') return Object.keys(a).length === 0;
    return false;
}

// ── equals ───────────────────────────────────────────────────────────────

/** A number, or text that is one (`" -12.5 "`); null for anything else. */
function numberOf(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let i = s[0] === '-' ? 1 : 0;
    const start = i;
    while (i < s.length && isDigit(s[i])) i++;
    if (i === start) return null;
    if (s[i] === '.') {
        const frac = ++i;
        while (i < s.length && isDigit(s[i])) i++;
        if (i === frac) return null;
    }
    return i === s.length ? Number(s) : null;
}

/** JSON with every record's keys sorted, so `{a,b}` and `{b,a}` read the same; null when it cannot be written. */
function sortedJson(v) {
    try {
        return JSON.stringify(v, (_k, val) => (isPlainObject(val)
            ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
            : val));
    } catch {
        return null;
    }
}

/**
 * The `equals(a, b)` function: the same value, where text ignores upper/lower
 * case and surrounding spaces, and "5" equals 5 (a number against numeric
 * text; two texts always compare as text, so "007" is not "7"). Lists compare element by
 * element, records by their keys and values. Nothing equals only nothing.
 */
export function equalsValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalsValue(x, b[i]));
    }
    if (typeof a === 'object' || typeof b === 'object') {
        if (!isPlainObject(a) || !isPlainObject(b)) return false;
        const ja = sortedJson(a);
        return ja !== null && ja === sortedJson(b);
    }
    // Numbers compare as numbers only when one side IS a number: two texts
    // compare as text, so "007" is not "7" and two long IDs that only a
    // float would round together stay apart.
    if (typeof a === 'number' || typeof b === 'number') {
        const na = numberOf(a);
        const nb = numberOf(b);
        if (na !== null && nb !== null) return na === nb;
    }
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ── Quantifiers ──────────────────────────────────────────────────────────

export const QUANTIFIER_FN = Object.freeze({ any: 'anyOf', every: 'everyOf', none: 'noneOf' });
export const QUANTIFIER_OF_FN = Object.freeze({ anyOf: 'any', everyOf: 'every', noneOf: 'none' });

/** Operator key of a rule row → the test name a quantified call carries. */
export const TEST_OF_OP = Object.freeze({
    is: 'equals', isNot: '!equals', eq: '==', neq: '!=',
    contains: 'contains', notContains: '!contains', startsWith: 'startsWith', endsWith: 'endsWith',
    gt: '>', gte: '>=', lt: '<', lte: '<=', isEmpty: 'isEmpty', isNotEmpty: '!isEmpty',
});
export const OP_OF_TEST = Object.freeze(Object.fromEntries(Object.entries(TEST_OF_OP).map(([op, test]) => [test, op])));
export const UNARY_TESTS = Object.freeze(['isEmpty', '!isEmpty']);

const TESTS = Object.freeze({
    equals: (el, v) => equalsValue(el, v),
    '!equals': (el, v) => !equalsValue(el, v),
    '==': (el, v) => el == v,
    '!=': (el, v) => el != v,
    contains: (el, v) => textContains(el, v),
    '!contains': (el, v) => !textContains(el, v),
    startsWith: (el, v) => textStartsWith(el, v),
    endsWith: (el, v) => textEndsWith(el, v),
    '>': (el, v) => el > v,
    '>=': (el, v) => el >= v,
    '<': (el, v) => el < v,
    '<=': (el, v) => el <= v,
    isEmpty: (el) => isEmptyValue(el),
    '!isEmpty': (el) => !isEmptyValue(el),
});

/** The function behind a test name; throws on a test that does not exist (a typo fails loudly). */
function testFn(test) {
    if (typeof test !== 'string' || !Object.prototype.hasOwnProperty.call(TESTS, test)) {
        throw new Error(`Unknown test "${test}". Use one of: ${Object.keys(TESTS).join(', ')}`);
    }
    return TESTS[test];
}

/** Does one list entry pass `test` against `value`? Throws on a test that does not exist. */
export function elementPasses(el, test, value) {
    return testFn(test)(el, value);
}

/** The entries a quantifier checks: a list, a list held as JSON text, nothing (none), or one value. */
function entriesOf(list) {
    if (Array.isArray(list)) return list;
    if (list == null) return [];
    if (typeof list === 'string') {
        const parsed = parseJsonText(list);
        if (Array.isArray(parsed)) return parsed;
    }
    return [list];
}

/**
 * any: at least one entry passes; every: the list is not empty and all pass;
 * none: no entry passes (also true for an empty list). The test is checked
 * even when the list is empty, so a typo fails on every item, not just some.
 */
export function quantify(quantifier, list, test, value) {
    const fn = testFn(test);
    const entries = entriesOf(list);
    const passes = (el) => fn(el, value);
    if (quantifier === 'any') return entries.some(passes);
    if (quantifier === 'every') return entries.length > 0 && entries.every(passes);
    if (quantifier === 'none') return !entries.some(passes);
    throw new Error(`Unknown quantifier "${quantifier}". Use any, every or none`);
}

// ── Rule shapes ──────────────────────────────────────────────────────────

const FILE_TYPE_OPEN = 'fileType(';

/**
 * What the left side of a rule row is, or null when it is no field:
 *   plain       item.subject (no [*])
 *   column      item.attachments[*].mimeType: one [*], not first, not last
 *   fileRecord  fileType(item)
 *   fileList    fileType(item.attachments[*]): the [*] last and only
 */
export function fieldShape(text) {
    const t = String(text ?? '').trim();
    if (t.startsWith(FILE_TYPE_OPEN) && t.endsWith(')')) return fileShape(t.slice(FILE_TYPE_OPEN.length, -1));
    const tokens = parsePath(t);
    if (!tokens || !isIdentifierKey(tokens[0].key)) return null;
    const wilds = tokens.flatMap((tok, i) => (tok.type === 'wild' ? [i] : []));
    if (wilds.length === 0) return { kind: 'plain', path: formatPath(tokens) };
    const w = wilds[0];
    if (wilds.length > 1 || w === 0 || w === tokens.length - 1) return null;
    return { kind: 'column', path: formatPath(tokens), list: formatPath(tokens.slice(0, w)), column: formatPath(tokens.slice(w + 1)) };
}

function fileShape(inner) {
    const tokens = parsePath(inner);
    if (!tokens || !isIdentifierKey(tokens[0].key)) return null;
    const wilds = tokens.filter((tok) => tok.type === 'wild').length;
    if (wilds === 0) {
        const record = formatPath(tokens);
        return { kind: 'fileRecord', path: fileTypeField(record), record };
    }
    if (wilds > 1 || tokens.length < 2 || tokens[tokens.length - 1].type !== 'wild') return null;
    const list = formatPath(tokens.slice(0, -1));
    return { kind: 'fileList', path: fileTypeField(list, { list: true }), list };
}

/** `anyOf(left, "<test>"[, rhs])` for a quantified row; '' for an unknown quantifier or operator. */
export function quantifiedCall(quantifier, left, op, rhs) {
    const fn = Object.prototype.hasOwnProperty.call(QUANTIFIER_FN, quantifier) ? QUANTIFIER_FN[quantifier] : null;
    const test = Object.prototype.hasOwnProperty.call(TEST_OF_OP, op) ? TEST_OF_OP[op] : null;
    if (!fn || !test) return '';
    return UNARY_TESTS.includes(test) ? `${fn}(${left}, "${test}")` : `${fn}(${left}, "${test}", ${rhs})`;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** The text of a quoted literal (`"x"` or `'x'`, backslash escapes); null when it is not exactly one. */
function quotedText(raw) {
    const q = raw[0];
    if (raw.length < 2 || (q !== '"' && q !== "'") || raw[raw.length - 1] !== q) return null;
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
        const c = raw[i];
        if (c === q) return null;
        if (c !== '\\') { out += c; continue; }
        if (++i >= raw.length - 1) return null;
        out += ESCAPES[raw[i]] ?? raw[i];
    }
    return out;
}

/**
 * Read a whole `anyOf|everyOf|noneOf(left, "<test>"[, rhs])` back:
 * `{ quantifier, left, op, rhs }` (rhs null for a unary test), or null when
 * the text is anything else (`!anyOf(…)` included: "no" says that).
 */
export function readQuantifiedCall(text) {
    const t = String(text ?? '').trim();
    const fn = Object.keys(QUANTIFIER_OF_FN).find((name) => t.startsWith(`${name}(`));
    if (!fn) return null;
    const inner = splitCallArgs(t, fn.length + 1);
    if (!inner || inner.end !== t.length - 1) return null;
    const { args } = inner;
    const test = args[1] === undefined ? null : quotedText(args[1]);
    if (!args[0] || test === null || !Object.prototype.hasOwnProperty.call(OP_OF_TEST, test)) return null;
    const unary = UNARY_TESTS.includes(test);
    if (args.length !== (unary ? 2 : 3) || (!unary && !args[2])) return null;
    return { quantifier: QUANTIFIER_OF_FN[fn], left: args[0], op: OP_OF_TEST[test], rhs: unary ? null : args[2] };
}

/** One entry of a list key: attachments → attachment, categories → category, status stays. */
export function singularKey(key) {
    const s = String(key ?? '');
    const lower = s.toLowerCase();
    if (lower.endsWith('ies')) return `${s.slice(0, -3)}y`;
    if (['sses', 'xes', 'zes', 'ches', 'shes'].some((end) => lower.endsWith(end))) return s.slice(0, -2);
    if (['ss', 'us', 'is'].some((end) => lower.endsWith(end))) return s;
    if (lower.endsWith('s') && s.length > 2) return s.slice(0, -1);
    return s;
}
