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
 *
 * repairLegacyPath reads what people and models write when they mean a path
 * but REF_RE rejects it (`items.0.name`, `body.content-type`,
 * `steps[x].output`), and writes it the one canonical way.
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
 * One segment in legacy spelling (`.key`, `[0]`, `["a key"]`, `[*]`), or null
 * when the grammar cannot hold it.
 * @param {string|number|object} seg
 */
export function formatSegment(seg) {
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

// Characters that end a path written by hand or by a model: what follows them
// is not part of it (`loop.x.output.a\"}}},tempId:` is the measured case of a
// model's JSON leaking into a path). Inside a bracket they are part of a key.
const PATH_END = new Set(['"', "'", '\\', '{', '}', '(', ')', '<', '>', ',', ';', ':', '|', '`', '=', '+', '!', '?', '&']);
const ROOT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** A segment read from a bracket: `*`, an index, a quoted or bare key. */
function bracketSegment(raw) {
    const t = raw.trim();
    if (t === '*') return WILD;
    if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
    return t === '' ? null : t;
}

/**
 * Read a path the way its writer meant it, even where REF_RE rejects it, and
 * spell it canonically. Returns `{ path, rest }`: `path` is the canonical
 * spelling of the longest readable start (null when not even the root reads),
 * `rest` the text after it that is not a path (`''` when all of it was).
 *
 *   'steps.x.output.items.0.name'      → steps.x.output.items[0].name
 *   'trigger.output.body.content-type' → trigger.output.body["content-type"]
 *   'trigger.output.Order date'        → trigger.output["Order date"]
 *   'steps[x].output[y]'               → steps.x.output.y
 *   ' steps . x . output '             → steps.x.output
 *   'loop.x.output.a\"}},tempId:'      → loop.x.output.a, rest '\"}},tempId:'
 *
 * A dotted segment of digits is an index; any other dotted segment is a key,
 * spaces and hyphens included. A path REF_RE already accepts is rewritten too
 * (`['a']` → `.a`), so a caller that must leave a valid path alone checks
 * REF_RE first. Writes never lose a key: a segment the grammar cannot spell
 * ends the path there and goes into `rest`.
 * @param {unknown} text
 * @returns {{ path: string|null, rest: string }}
 */
export function repairLegacyPath(text) {
    const s = typeof text === 'string' ? text : '';
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    const root = ROOT_RE.exec(s.slice(i));
    if (!root) return { path: null, rest: s.slice(i) };
    let out = root[0];
    i += root[0].length;
    for (;;) {
        let j = i;
        while (j < s.length && /\s/.test(s[j])) j++;
        const c = s[j];
        let seg;
        let next;
        if (c === '.') {
            j++;
            while (j < s.length && /\s/.test(s[j])) j++;
            // A doubled dot is a typo, not an empty key.
            if (s[j] === '.') { i = j; continue; }
            if (s[j] === '[') { i = j; continue; }
            let k = j;
            while (k < s.length && s[k] !== '.' && s[k] !== '[' && !PATH_END.has(s[k])) k++;
            const raw = s.slice(j, k).trim();
            if (!raw) break;
            seg = /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : raw;
            next = k;
        } else if (c === '[') {
            let k = j + 1;
            while (k < s.length && /\s/.test(s[k])) k++;
            const q = s[k];
            if (q === '"' || q === "'") {
                const close = s.indexOf(q, k + 1);
                if (close < 0) break;
                let m = close + 1;
                while (m < s.length && /\s/.test(s[m])) m++;
                if (s[m] !== ']') break;
                seg = s.slice(k + 1, close);
                next = m + 1;
            } else {
                const close = s.indexOf(']', j);
                if (close < 0) break;
                seg = bracketSegment(s.slice(j + 1, close));
                if (seg === null) break;
                next = close + 1;
            }
        } else {
            break;
        }
        const written = formatSegment(seg);
        if (written === null) break;
        out += written;
        i = next;
    }
    // A trailing dot is a typo too, not the start of a key.
    const rest = s.slice(i);
    return { path: out, rest: /^[\s.]*$/.test(rest) ? '' : rest };
}
