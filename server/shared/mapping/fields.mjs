/**
 * Fields: what a sample (or a real output) offers to pick, as SourceNodes.
 *
 *   fieldsFromSample(sample, base)  every key, at any depth (MAX_DEPTH),
 *                                   lists opened to their element columns
 *   sampleFromSchema(schema)        a declared output schema as a sample,
 *                                   nested objects and list items included
 *   overlayReal(fields, real)       marks the keys a real output lacks
 *   textChildren(node)              a JSON string read as the object it holds
 *
 * A SourceNode carries the value's Source (`{root, id?, path}`: strings and
 * integers, no grammar) beside the legacy `path` string formatPath writes
 * from it, so the builder's string-based field components keep working while
 * the new ones read the Source. `key`/`path`/`sample`/`children` are the
 * shape every picker has always read; the rest is new:
 *
 *   { key, path, sample, children?,
 *     source,       the Source, or null under a base that is not one
 *     labelParts,   label.mjs parts from the group's base to this value
 *     shape,        'scalar' | 'object' | 'list' | 'table' | 'json'
 *     count?,       how many elements, for a list or a table
 *     preview,      a short, language-free text of the value ('' for none)
 *     confirmed }   false when real output exists and lacks this key
 *
 * A key the legacy grammar cannot write (a `]`, or both quote styles, see
 * source.mjs formatSegment) is left out: offering it would be offering a
 * path that resolves to nothing. So is an own `__proto__` key (see
 * REFUSED_KEYS); every other own key, `length` and `constructor` included,
 * resolves through the runtime walker and is offered.
 */

import { WILD, isWild, formatSegment, parseLegacyPath } from './source.mjs';
import { labelParts } from './label.mjs';

/** How deep the field tree opens: a key five levels down is still offered. */
export const MAX_DEPTH = 6;
/** How many list elements contribute columns. */
const COLUMN_SCAN = 20;
/** A JSON string larger than this is not read as an object. */
const JSON_TEXT_CAP = 1024 * 1024;
const PREVIEW_MAX = 60;
/**
 * Own keys that are never offered. The runtime walker resolves every OWN key
 * (legacy.mjs resolveTokens only refuses what comes from the prototype chain),
 * so a payload's `length` or `constructor` field is a real field and stays.
 * `__proto__` alone is left out: a sample copied into a plain object through
 * that key would set the copy's prototype instead of a field.
 */
const REFUSED_KEYS = new Set(['__proto__']);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A describer's stand-in for a value nobody has seen yet: `<parsed body>`. */
export function isPlaceholder(v) {
    return typeof v === 'string' && v.length > 2 && v.startsWith('<') && v.endsWith('>');
}

// The last texts read, so a tree rebuilt on every edit does not parse the same
// response body again each time. Small: it only has to span one rebuild.
const TEXT_MEMO = new Map();
const TEXT_MEMO_SIZE = 32;

/** The object or list a JSON string holds, or undefined when it holds none. */
function parseJsonText(v) {
    if (typeof v !== 'string' || v.length > JSON_TEXT_CAP) return undefined;
    const t = v.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
    if (TEXT_MEMO.has(t)) return TEXT_MEMO.get(t);
    let parsed;
    try {
        const value = JSON.parse(t);
        parsed = value !== null && typeof value === 'object' ? value : undefined;
    } catch {
        parsed = undefined;
    }
    if (TEXT_MEMO.size >= TEXT_MEMO_SIZE) TEXT_MEMO.delete(TEXT_MEMO.keys().next().value);
    TEXT_MEMO.set(t, parsed);
    return parsed;
}

/**
 * The shape of one sample value.
 *
 * TODO(mapping M2 merge): shape.mjs (shapeOf) replaces this once M2 lands;
 * it is kept private to this file until then so the two never disagree in
 * public.
 * @param {unknown} v
 * @returns {'missing'|'scalar'|'object'|'list'|'table'|'json'}
 */
export function shapeOfSample(v) {
    if (v === undefined) return 'missing';
    if (Array.isArray(v)) return v.some(isPlainObject) ? 'table' : 'list';
    if (isPlainObject(v)) return 'object';
    if (parseJsonText(v) !== undefined) return 'json';
    return 'scalar';
}

/** A short text of a value for the grey preview column; '' when a word would lie. */
export function previewOf(v) {
    if (v === null || v === undefined || isPlaceholder(v)) return '';
    if (typeof v === 'string') {
        const one = v.replace(/\s+/g, ' ').trim();
        return one.length > PREVIEW_MAX ? `${one.slice(0, PREVIEW_MAX - 1)}…` : one;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
}

/**
 * Overlay real output onto a design-time sample, key by key. Real data wins;
 * a real scalar or list replaces the sample subtree wholesale (a real Gmail
 * `results` array is the truth, not a merge candidate). Sample keys the real
 * output lacks survive: overlayReal marks them.
 */
export function deepOverlay(base, real) {
    if (real === null || typeof real !== 'object' || Array.isArray(real)) return real;
    if (base === null || typeof base !== 'object' || Array.isArray(base)) return real;
    const out = { ...base };
    for (const k of Object.keys(real)) out[k] = (k in base) ? deepOverlay(base[k], real[k]) : real[k];
    return out;
}

/**
 * Does `value` hold something at these relative segments? A `[*]` asks
 * whether any element does. Only own keys count, as in the walker.
 */
export function hasPath(value, segs) {
    let cur = value;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (isWild(seg)) {
            if (!Array.isArray(cur)) return false;
            const rest = segs.slice(i + 1);
            return cur.some(el => hasPath(el, rest));
        }
        if (cur === null || typeof cur !== 'object') return false;
        if (typeof seg === 'number' ? !Array.isArray(cur) : Array.isArray(cur)) return false;
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
        cur = cur[seg];
    }
    return true;
}

/**
 * Where a field tree hangs: the Source and legacy path of its base, and the
 * segments walked from the group's base (for labels and confirmation).
 * A base string that is not a Source (`item`, `loop.x` in some editors) still
 * gets correct legacy paths; its nodes just carry no Source.
 */
export function baseOf(base) {
    if (typeof base === 'string') {
        const source = parseLegacyPath(base);
        return { source, text: base, rel: [] };
    }
    if (base && typeof base === 'object' && typeof base.text === 'string' && Array.isArray(base.rel)) return base;
    return { source: null, text: '', rel: [] };
}

/** The base one segment further down, or null when the grammar cannot write it. */
export function childBase(at, seg) {
    const written = formatSegment(seg);
    if (written === null) return null;
    return {
        source: at.source ? { ...at.source, path: [...at.source.path, seg] } : null,
        text: `${at.text}${written}`,
        rel: [...at.rel, seg],
    };
}

/** One SourceNode at `at` holding `sample`. */
export function makeNode(at, key, sample, extra = {}) {
    const shape = shapeOfSample(sample);
    const node = {
        key: String(key),
        path: at.text,
        sample,
        source: at.source,
        labelParts: labelParts(at.rel),
        shape,
        preview: previewOf(sample),
        confirmed: true,
        ...extra,
    };
    if (Array.isArray(sample)) node.count = sample.length;
    return node;
}

/** The column keys of a list's elements, first-seen order, with a sample each. */
function columnsOf(list) {
    const cols = new Map();
    for (const el of list.slice(0, COLUMN_SCAN)) {
        if (!isPlainObject(el)) continue;
        for (const [k, v] of Object.entries(el)) {
            if (!cols.has(k) || (cols.get(k) === undefined && v !== undefined)) cols.set(k, v);
        }
    }
    return cols;
}

function keyOffered(k) {
    return !REFUSED_KEYS.has(k);
}

/**
 * The children of one value: an object's keys, or a table's columns under
 * `[*]` (the legacy flatten every runtime resolves). Plain lists and
 * scalars have none.
 */
function childrenOf(value, at, depth, opts) {
    if (depth >= MAX_DEPTH) return [];
    if (isPlainObject(value)) return nodesOfObject(value, at, depth, opts);
    if (Array.isArray(value) && value.some(isPlainObject)) {
        const wild = childBase(at, WILD);
        const out = [];
        for (const [k, v] of columnsOf(value)) {
            if (!keyOffered(k)) continue;
            const node = nodeAt(wild, k, v, depth, opts);
            if (node) out.push(node);
        }
        return out;
    }
    return [];
}

function nodeAt(at, k, v, depth, opts) {
    const here = childBase(at, k);
    if (!here) return null;
    const node = makeNode(here, k, v, opts.extra);
    const children = childrenOf(v, here, depth + 1, opts);
    if (children.length) node.children = children;
    return node;
}

/**
 * A node at an already-built base, opened like any field: an object to its
 * keys, a table to its columns. For curated fields a describer places itself.
 */
export function nodeTree(at, key, sample, extra = {}) {
    const node = makeNode(at, key, sample, extra);
    const children = childrenOf(sample, at, Math.max(1, at.rel.length), {});
    if (children.length) node.children = children;
    return node;
}

function nodesOfObject(obj, at, depth, opts) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        if (!keyOffered(k)) continue;
        const node = nodeAt(at, k, v, depth, opts);
        if (node) out.push(node);
    }
    return out;
}

/**
 * Every pickable value under `sample`, as SourceNodes hanging from `base`
 * (a legacy path string such as `steps.s1.output`, or a base from baseOf).
 *
 * Objects open to their keys at any depth up to MAX_DEPTH. A list of objects
 * opens to its columns (`items[*].sku`), before any run, from whatever its
 * elements hold. A non-object sample has no fields: the group itself is the
 * value.
 * @param {unknown} sample
 * @param {string|object} base
 */
export function fieldsFromSample(sample, base) {
    if (!isPlainObject(sample)) return [];
    return nodesOfObject(sample, baseOf(base), 0, {});
}

/**
 * The children of a JSON string node, read from the text: what the value
 * holds once the string is parsed. The legacy walker does not parse strings,
 * so these carry a Source and no legacy `path` (null): they can be shown with
 * the hint that they were read from text, never inserted as a legacy ref.
 */
export function textChildren(node) {
    if (!node || typeof node !== 'object') return [];
    const parsed = parseJsonText(node.sample);
    if (parsed === undefined) return [];
    const at = { source: node.source || null, text: '', rel: [] };
    const strip = (n) => {
        const out = { ...n, path: null, fromText: true };
        if (n.children) out.children = n.children.map(strip);
        return out;
    };
    if (Array.isArray(parsed)) return childrenOf(parsed, at, 0, {}).map(strip);
    return nodesOfObject(parsed, at, 0, {}).map(strip);
}

/**
 * The placeholder a declared field type stands for before any run.
 * `file` is what an app trigger's file input arrives as (appStudio
 * actionExecutor), so `trigger.output.<name>.url` is pickable.
 */
export function samplePlaceholderFor(type) {
    switch (type) {
        case 'number': case 'integer': return 0;
        case 'boolean': return false;
        case 'object': return {};
        case 'array': return [];
        case 'file': return { fileId: '<file-id>', name: 'document.pdf', mime: 'application/pdf', size: 12345, url: '<signed download url>' };
        default: return '<string>';
    }
}

/**
 * A sample in the shape a declared schema promises. Accepts a JSON schema
 * (`{type:'object', properties}`), the flat `{field: 'type'}` form the AI
 * step also takes, and the `outputFields` rows a skill declares
 * (`[{key, type}]`). Nested objects keep their properties, and a list keeps
 * one element in the shape of its `items`, so its columns are pickable
 * before the first run. Null when the schema declares no field.
 */
export function sampleFromSchema(schema) {
    const props = schemaProperties(schema);
    if (!props) return null;
    const out = {};
    for (const [k, def] of Object.entries(props)) out[k] = sampleOfDef(def, 0);
    return out;
}

function schemaProperties(schema) {
    if (Array.isArray(schema)) {
        const rows = schema.filter(r => isPlainObject(r) && typeof (r.key || r.name) === 'string' && (r.key || r.name));
        if (!rows.length) return null;
        return Object.fromEntries(rows.map(r => [r.key || r.name, typeof r.type === 'string' ? r.type : 'string']));
    }
    if (!isPlainObject(schema)) return null;
    // A JSON schema object with no properties declares no field (its `type`
    // is not a field called "type").
    if (!isPlainObject(schema.properties) && schema.type === 'object') return null;
    const raw = isPlainObject(schema.properties) ? schema.properties : schema;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!k) continue;
        if (typeof v === 'string' || isPlainObject(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

function sampleOfDef(def, depth) {
    if (typeof def === 'string') return samplePlaceholderFor(def);
    if (!isPlainObject(def)) return samplePlaceholderFor('string');
    const type = typeof def.type === 'string' ? def.type : (isPlainObject(def.properties) ? 'object' : 'string');
    if (depth >= MAX_DEPTH) return samplePlaceholderFor(type);
    if (type === 'object' && isPlainObject(def.properties)) {
        const out = {};
        for (const [k, v] of Object.entries(def.properties)) out[k] = sampleOfDef(v, depth + 1);
        return out;
    }
    if (type === 'array' && (isPlainObject(def.items) || typeof def.items === 'string')) {
        return [sampleOfDef(def.items, depth + 1)];
    }
    return samplePlaceholderFor(type);
}

/**
 * Mark the fields a real output does not have. A field stays in the list (a
 * describer may know keys one particular run did not produce), but with
 * `confirmed: false`, so the picker can dim it and say so. Children are
 * marked too. `real` is the value at the fields' base.
 */
export function overlayReal(fields, real) {
    const mark = (f) => {
        const segs = relativeSegments(f);
        const confirmed = segs === null ? f.confirmed !== false : hasPath(real, segs);
        const out = { ...f, confirmed };
        if (Array.isArray(f.children)) out.children = f.children.map(mark);
        return out;
    };
    return (fields || []).map(mark);
}

/** The segments from the group's base to a field, from its labelParts. */
function relativeSegments(f) {
    if (!Array.isArray(f?.labelParts)) return null;
    return f.labelParts.map(p => (p.each ? WILD : p.index !== undefined ? p.index : p.key));
}
