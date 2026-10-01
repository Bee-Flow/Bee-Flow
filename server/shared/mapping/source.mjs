/**
 * Source: where a value comes from, as data instead of as a path string.
 *
 *   { root: 'steps',   id: 's1', path: ['orders', 0, 'sku'] }   steps.s1.output.orders[0].sku
 *   { root: 'trigger',           path: ['Klant', 'E-mail adres'] } trigger.output.Klant["E-mail adres"]
 *   { root: 'loop',    id: 'row', path: ['name'] }              loop.row.name
 *   { root: 'vars',              path: ['rate'] }                vars.rate
 *
 * `path` is relative to the step's or the trigger's `output`. A segment is a
 * string (an object key, any characters) or a non-negative integer (an array
 * index), so a Source needs no grammar and no escaping. A legacy `[*]` is the
 * WILD segment; it exists so a stored legacy ref can be parsed and written
 * back unchanged, and new mappings never store it.
 *
 * formatPath is THE one rule for writing a Source as a legacy path string:
 * an identifier key is `.key`, an index is `[n]`, any other key is
 * `["key"]` (or `['key']` when the key holds a double quote). Keys the legacy
 * grammar cannot express at all (a `]`, or both quote styles) make it return
 * null rather than a path that resolves to something else.
 *
 * parseLegacyPath is its inverse for the paths a Source can name:
 * formatPath(parseLegacyPath(p)) is p in canonical spelling. Paths that do not
 * read a value Source (step status/error, `trigger.x` without `.output`,
 * secrets, anything REF_RE rejects) parse to null.
 */

import { REF_RE, tokenizePath } from './legacy.mjs';

/** The legacy `[*]` segment: map the rest of the path over a list, flattened one level. */
export const WILD = Object.freeze({ wild: true });

/** Is this segment the legacy `[*]`? (Survives a JSON round trip, unlike identity.) */
export function isWild(seg) {
    return seg !== null && typeof seg === 'object' && seg.wild === true;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Roots whose second segment is a name (a step id, a loop item variable). */
const NAMED_ROOTS = new Set(['steps', 'loop']);
/** Roots whose values live under `.output`. */
const OUTPUT_ROOTS = new Set(['steps', 'trigger']);
const ROOTS = new Set(['steps', 'trigger', 'loop', 'vars']);

function tokenToSegment(tok) {
    return tok.type === 'wild' ? WILD : tok.key;
}

/**
 * The Source a legacy ref path reads, or null when it reads none.
 * @param {unknown} path
 */
export function parseLegacyPath(path) {
    if (typeof path !== 'string' || !REF_RE.test(path)) return null;
    const tokens = tokenizePath(path);
    if (!tokens || !tokens.length) return null;
    const [first, ...rest] = tokens;
    const root = first.key;
    if (!ROOTS.has(root)) return null;
    const source = { root };
    if (NAMED_ROOTS.has(root)) {
        const name = rest.shift();
        if (!name || name.type !== 'prop' || typeof name.key !== 'string' || name.key === '') return null;
        source.id = name.key;
    }
    if (OUTPUT_ROOTS.has(root)) {
        const output = rest.shift();
        if (!output || output.type !== 'prop' || output.key !== 'output') return null;
    }
    source.path = rest.map(tokenToSegment);
    return source;
}

/**
 * One segment in legacy spelling, or null when the grammar cannot hold it.
 * @param {string|number|object} seg
 */
function formatSegment(seg) {
    if (isWild(seg)) return '[*]';
    if (typeof seg === 'number') return Number.isSafeInteger(seg) && seg >= 0 ? `[${seg}]` : null;
    if (typeof seg !== 'string') return null;
    if (IDENT_RE.test(seg)) return `.${seg}`;
    // The tokenizer closes a bracket at the FIRST `]` and knows no escapes.
    if (seg.includes(']')) return null;
    if (!seg.includes('"')) return `["${seg}"]`;
    if (!seg.includes("'")) return `['${seg}']`;
    return null;
}

/**
 * Write a Source as the legacy path string the runtime resolves, or null when
 * it is not a well-formed Source or holds a key the grammar cannot express.
 * @param {{root: string, id?: string, path?: Array<string|number|object>}} source
 */
export function formatPath(source) {
    if (!source || typeof source !== 'object' || !ROOTS.has(source.root)) return null;
    const segs = [];
    if (NAMED_ROOTS.has(source.root)) {
        if (typeof source.id !== 'string' || source.id === '') return null;
        segs.push(source.id);
    }
    if (OUTPUT_ROOTS.has(source.root)) segs.push('output');
    const path = source.path == null ? [] : source.path;
    if (!Array.isArray(path)) return null;
    let out = source.root;
    for (const seg of [...segs, ...path]) {
        const text = formatSegment(seg);
        if (text === null) return null;
        out += text;
    }
    return out;
}

/**
 * The last key of a path (a legacy path string or a Source): what a field
 * named after the value it holds would be called. `[*]` is skipped, so
 * `items[*].sku` gives 'sku'. Undefined when there is none.
 * @param {string | {path?: unknown[]}} pathOrSource
 */
export function lastSegment(pathOrSource) {
    let segs;
    if (typeof pathOrSource === 'string') {
        if (!REF_RE.test(pathOrSource)) return undefined;
        const tokens = tokenizePath(pathOrSource);
        if (!tokens) return undefined;
        segs = tokens.map(tokenToSegment);
    } else if (pathOrSource && Array.isArray(pathOrSource.path)) {
        segs = pathOrSource.path;
    } else {
        return undefined;
    }
    for (let i = segs.length - 1; i >= 0; i--) {
        if (!isWild(segs[i])) return segs[i];
    }
    return undefined;
}
