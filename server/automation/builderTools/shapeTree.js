/**
 * Builder tools — the SHAPE of a value, deep: keys and types, never values,
 * so a path the AI binds can be checked all the way down and the AI can be
 * shown the structure it binds against.
 *
 * WHY. The builder's field knowledge was two levels deep and read one list
 * element: `messages: array of { id, payload }` was all the AI saw of a Gmail
 * page, and a field present on message 2 but not on message 1 was refused as
 * missing. A shape here is built from every source we have and merged:
 *
 *   fromValue       a real value — a dry-run output, a declared sample. Lists
 *                   are the UNION of their elements (not element 0), JSON
 *                   text is read as the value it encodes (the run reads
 *                   `body.data.items[0]` straight through a JSON string).
 *                   Up to a node budget every element is read; a list cut
 *                   short is OPEN below it (an unread entry may carry keys
 *                   the read ones lack).
 *   fromDescriptor  a shapeCache descriptor ({ _array, _length }, '<deep>').
 *   fromCurated     an outputSchemas.js `shape` (description strings such as
 *                   'array of { id, from, subject }').
 *
 * Nodes:
 *   { t:'obj', keys: Map, open, sure }   open = more keys may exist
 *   { t:'arr', item, sure, pairs? }      item null = an empty list, unknown
 *   { t:'str' | 'num' | 'bool' | 'null' }
 *   { t:'any' }                           unknown: every path below is fine
 *
 * `sure` says the key set is COMPLETE, authoritative enough to REFUSE a
 * binding: what the step's own config declares (extraction fields, a set's
 * fields) or the runner always returns (a forEach's results envelope). One
 * observed run (a dry run, a tool's last live run) is not: a key it lacked
 * may be optional, so its objects are `sure: false` while the STRUCTURE it
 * shows (this is a list, that is a number) stays sure. A shape only a static
 * description vouches for is `sure: false` throughout: a document can lag the
 * tool it describes. A miss on a shape that is not sure is a warning with a
 * did-you-mean, never a refusal.
 *
 * `pairs` marks a list of name/value entries (mail headers, tags, device
 * status codes): the names seen, so `headers.subject` can become
 * `headers[name="Subject"].value`. Only names that look like field names
 * count: a list of people, addresses or prose is data, and its entries are
 * never echoed to the builder model.
 *
 * Pure. Required by refCheck.js, outputFields.js, inspection.js and the
 * dry-run hint in ../builderTools.js.
 */

'use strict';

const { parseJsonText, appendKey, appendWildcard, appendMatch } = require('../expr');

const MAX_DEPTH = 16;
// How many nodes one value is read with before its lists are cut short. A
// dry-run page (hundreds of messages or rows) is read whole, so a field only
// one entry carries is a field; past it each list reads one more entry and
// what it may be hiding is left open.
const NODE_BUDGET = 20000;
const MAX_KEYS = 300;
const MAX_PAIR_NAMES = 100;
const PAIR_NAME_KEYS = ['name', 'key', 'code', 'field'];
const PAIR_VALUE_KEYS = ['value', 'values'];
// What a field name looks like (Subject, Content-Type, X-Mailer, ERR_42):
// never whitespace, `@`, quotes or brackets, so a person, an address or a
// sentence in sample data is not one.
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const MAX_SHOWN_NAME = 30;

const ANY = Object.freeze({ t: 'any' });

const isContainer = n => !!n && (n.t === 'obj' || n.t === 'arr');

/**
 * A shape in which nothing is complete any more: every object may hold more
 * keys, no list is authoritative. Below a list that was not read whole an
 * unread entry may carry keys, or types, the read ones do not.
 */
function openDeep(n, depth = 0) {
    if (!n || depth > MAX_DEPTH) return n;
    if (n.t === 'obj') {
        const keys = new Map();
        for (const [k, v] of n.keys) keys.set(k, openDeep(v, depth + 1));
        return { ...n, keys, open: true, sure: false };
    }
    if (n.t === 'arr') return { ...n, item: openDeep(n.item, depth + 1), sure: false };
    return n;
}

/**
 * A list whose entries are name/value pairs: every entry an object with a
 * string under one of PAIR_NAME_KEYS, and a value key beside it. The names
 * are field names of the payload (header names, status codes), kept short
 * and bounded; `byIndex` lets an index the AI wrote be named in advice. A
 * name that does not look like a field name (a person, an e-mail address,
 * sample prose) makes the list ordinary data.
 */
function pairsOf(list) {
    if (!list.length || list.length > 500) return null;
    if (!list.every(el => el && typeof el === 'object' && !Array.isArray(el))) return null;
    for (const nameKey of PAIR_NAME_KEYS) {
        if (!list.every(el => typeof el[nameKey] === 'string')) continue;
        if (!list.every(el => FIELD_NAME_RE.test(el[nameKey]))) return null;
        const valueKey = PAIR_VALUE_KEYS.find(v => list.some(el => Object.prototype.hasOwnProperty.call(el, v)));
        if (!valueKey) continue;
        const byIndex = list.slice(0, MAX_PAIR_NAMES).map(el => el[nameKey]);
        return { nameKey, valueKey, names: [...new Set(byIndex)], byIndex };
    }
    return null;
}

function mergePairs(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    if (a.nameKey !== b.nameKey) return null;
    const names = [...new Set([...a.names, ...b.names])].slice(0, MAX_PAIR_NAMES);
    // Positions only mean something when every list agrees on them.
    const same = a.byIndex && b.byIndex && a.byIndex.length === b.byIndex.length && a.byIndex.every((n, i) => n === b.byIndex[i]);
    return { nameKey: a.nameKey, valueKey: a.valueKey || b.valueKey, names, byIndex: same ? a.byIndex : null };
}

/**
 * The shape of a real value. `sure` (default true) marks it authoritative;
 * `keysSure: false` keeps its structure authoritative but not its key sets
 * (one observed run: a key it lacked may be optional); `open: true` leaves
 * every object open (a declared sample that may omit fields the real payload
 * carries, a preview that cut keys).
 */
function fromValue(value, opts = {}) {
    return readValue(value, opts, 0, { left: NODE_BUDGET });
}

function readValue(value, opts, depth, budget) {
    const sure = opts.sure !== false;
    budget.left--;
    if (depth > MAX_DEPTH) return ANY;
    if (value === null || value === undefined) return { t: 'null' };
    switch (typeof value) {
        case 'string': {
            const parsed = value.length > 1 ? parseJsonText(value) : undefined;
            if (parsed !== undefined) return { ...readValue(parsed, opts, depth + 1, budget), json: true };
            return { t: 'str' };
        }
        case 'number': return Number.isInteger(value) ? { t: 'num', int: true } : { t: 'num' };
        case 'bigint': return { t: 'num', int: true };
        case 'boolean': return { t: 'bool' };
        case 'object': break;
        default: return ANY;
    }
    if (Array.isArray(value)) {
        let item = null;
        let read = 0;
        for (const el of value) {
            // Past the budget one entry still shows what an entry looks like.
            if (read > 0 && budget.left <= 0) break;
            read++;
            if (el === undefined) continue;
            item = merge(item, readValue(el, opts, depth + 1, budget));
        }
        if (read < value.length) item = openDeep(item);
        const node = { t: 'arr', item, sure };
        const pairs = pairsOf(value);
        if (pairs) node.pairs = pairs;
        return node;
    }
    const keys = new Map();
    let open = !!opts.open;
    let n = 0;
    for (const k of Object.keys(value)) {
        if (n++ >= MAX_KEYS) { open = true; break; }
        keys.set(k, readValue(value[k], opts, depth + 1, budget));
    }
    return { t: 'obj', keys, open, sure: sure && opts.keysSure !== false };
}

/**
 * The shape of a shapeCache descriptor (what a tool returned on its LAST
 * real run, kept for 30 days). Its objects are `sure: false`: a key that run
 * lacked (a pagination cursor on the last page, an optional field) may be
 * there on the next. Its lists stay sure at the top (a list is a list), and
 * list items are `sure: false` throughout: descriptors recorded before
 * 2026-10 read element 0 only.
 */
function fromDescriptor(d, depth = 0, sure = true) {
    if (depth > MAX_DEPTH) return ANY;
    if (typeof d === 'string') {
        switch (d) {
            case 'string':
            case 'long-string': return { t: 'str' };
            case 'integer': return { t: 'num', int: true };
            case 'number': return { t: 'num' };
            case 'boolean': return { t: 'bool' };
            case 'null': return { t: 'null' };
            case 'array<empty>': return { t: 'arr', item: null, sure };
            default: return ANY;                       // '<deep>', 'mixed' and anything newer
        }
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return ANY;
    const own = k => Object.prototype.hasOwnProperty.call(d, k);
    if (own('_array')) return { t: 'arr', item: fromDescriptor(d._array, depth + 1, false), sure };
    // JSON text, described as what it encodes.
    if (own('_json') && Object.keys(d).length === 1) return { ...fromDescriptor(d._json, depth + 1, sure), json: true };
    const keys = new Map();
    for (const [k, v] of Object.entries(d)) keys.set(k, fromDescriptor(v, depth + 1, sure));
    // describeValue keeps 30 keys per object: at the cap, more may exist.
    return { t: 'obj', keys, open: keys.size >= 30, sure: false };
}

// ── Curated description strings ──────────────────────────────────────────

/** The text between the brace at `open` and its partner (or the end). */
function braced(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) return s.slice(open + 1, i);
    }
    return s.slice(open + 1);
}

/** Split on commas that sit outside {…}, (…) and […]. */
function splitTopLevel(s) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

/** `{ a, b: string, c (x|y), d: array of { e }, f: [{ g }] }` → an object shape. */
function objFromMembers(text, depth) {
    const keys = new Map();
    for (const part of splitTopLevel(text)) {
        const p = part.trim();
        const m = /^([A-Za-z_$@][\w$@-]*)\??/.exec(p);
        if (!m) continue;
        let rest = p.slice(m[0].length).trim();
        let node = ANY;
        if (rest.startsWith(':')) {
            rest = rest.slice(1).trim();
            node = rest.startsWith('[') && rest.includes('{')
                ? { t: 'arr', item: objFromMembers(braced(rest, rest.indexOf('{')), depth + 1), sure: false }
                : fromDescription(rest, depth + 1);
        } else if (rest.startsWith('{')) {
            node = objFromMembers(braced(rest, 0), depth + 1);
        }
        keys.set(m[1], node);
    }
    return { t: 'obj', keys, open: false, sure: false };
}

/** One curated description ('array of { id, name }', 'integer', 'object|undefined', …). */
function fromDescription(desc, depth = 0) {
    if (typeof desc !== 'string' || depth > MAX_DEPTH) return ANY;
    const s = desc.trim();
    const arrOf = /^array\s+of\s+/i.exec(s);
    if (arrOf) {
        const rest = s.slice(arrOf[0].length);
        if (rest.startsWith('{')) return { t: 'arr', item: objFromMembers(braced(rest, 0), depth + 1), sure: false };
        return { t: 'arr', item: scalarFromWord(rest), sure: false };
    }
    if (/^array\b/i.test(s)) return { t: 'arr', item: ANY, sure: false };
    if (/^[a-z]+\[\]/i.test(s)) return { t: 'arr', item: scalarFromWord(s), sure: false };
    if (/^(opaque\s+|object\s+)?\{/i.test(s)) return objFromMembers(braced(s, s.indexOf('{')), depth + 1);
    // A union with undefined/null is "maybe absent": only a lone type is known.
    if (/^\w+\s*\|/.test(s) && !/^string\s*\|/i.test(s)) return ANY;
    return scalarFromWord(s);
}

function scalarFromWord(s) {
    if (/^(string|text|markdown|iso|date|url|uri|email)\b/i.test(s)) return { t: 'str' };
    if (/^(integer|int)\b/i.test(s)) return { t: 'num', int: true };
    if (/^(number|float)\b/i.test(s)) return { t: 'num' };
    if (/^bool/i.test(s)) return { t: 'bool' };
    return ANY;
}

/** The shape an outputSchemas.js `shape` object describes (top level closed). */
function fromCurated(shape) {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return ANY;
    if (shape._string) return { t: 'str' };
    const keys = new Map();
    for (const [k, v] of Object.entries(shape)) {
        if (k.startsWith('_')) continue;
        keys.set(k, fromDescription(v));
    }
    return keys.size ? { t: 'obj', keys, open: false, sure: false } : ANY;
}

// ── Merging ──────────────────────────────────────────────────────────────

/**
 * The union of two shapes: every key either has, a list item merged across
 * both. Unknown wins (it may be anything); null gives way (an absent value
 * says nothing about the type); an object here and a list there is unknown.
 */
function merge(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    if (a.t === 'any' || b.t === 'any') return ANY;
    if (a.t === 'null') return b;
    if (b.t === 'null') return a;
    if (a.t !== b.t) {
        if (isContainer(a) && isContainer(b)) return ANY;
        // Text here, a structure there: the text may be JSON with other keys.
        const c = isContainer(a) ? a : isContainer(b) ? b : null;
        if (c) return c.t === 'obj' ? { ...c, open: true } : c;
        return { t: 'str' };
    }
    if (a.t === 'num') return a.int && b.int ? a : { t: 'num' };
    const flags = {
        ...(a.json || b.json ? { json: true } : {}),
        ...(a.envelope || b.envelope ? { envelope: true } : {}),
    };
    if (a.t === 'obj') {
        const keys = new Map(a.keys);
        for (const [k, v] of b.keys) keys.set(k, keys.has(k) ? merge(keys.get(k), v) : v);
        return { t: 'obj', keys, open: !!(a.open || b.open), sure: !!(a.sure || b.sure), ...flags };
    }
    if (a.t === 'arr') {
        const item = a.item === null ? b.item : b.item === null ? a.item : merge(a.item, b.item);
        const out = { t: 'arr', item, sure: !!(a.sure || b.sure), ...flags };
        const pairs = mergePairs(a.pairs, b.pairs);
        if (pairs) out.pairs = pairs;
        return out;
    }
    return a;
}

// ── Walking ──────────────────────────────────────────────────────────────

const isIndexKey = k => typeof k === 'number' || (typeof k === 'string' && /^-?[0-9]+$/.test(k));

/**
 * Walk path tokens over a shape, with the run's own rules (bind.js via
 * shared/expr/path.mjs): `[*]` maps the rest over the item and flattens one
 * level, an index or `[k=v]` reads the item, `.length` of a list or text is
 * a number, text may be JSON and is therefore never a dead end.
 *
 * Returns one of
 *   { status: 'ok', node }                     resolves; node is what it yields
 *   { status: 'unknown', at?, node? }          an unknown or open part was hit
 *                                              (at/node: an open object that
 *                                              lacks the key, for case repairs)
 *   { status: 'broken', at, node, reason, sure }  tokens[at] cannot resolve on
 *                                              node: 'missing' | 'key-on-list' |
 *                                              'not-list' | 'scalar' | 'match-key'
 * `indexHits` (on ok/unknown) lists numeric indices into name/value lists.
 */
function walk(node, tokens, from = 0, indexHits = []) {
    let cur = node;
    let sure = !!(node && node.sure);
    for (let i = from; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!cur || cur.t === 'any' || cur.t === 'null') return { status: 'unknown', indexHits };
        if (cur.t === 'str') {
            if (tok.type === 'prop' && tok.key === 'length') { cur = { t: 'num' }; continue; }
            return { status: 'unknown', indexHits };
        }
        if (cur.t === 'num' || cur.t === 'bool') return { status: 'broken', at: i, node: cur, reason: 'scalar', sure };
        sure = !!cur.sure;
        if (cur.t === 'arr') {
            if (tok.type === 'wild') {
                if (i === tokens.length - 1) return { status: 'ok', node: cur, indexHits };
                if (!cur.item) return { status: 'unknown', indexHits };
                const r = walk(cur.item, tokens, i + 1, indexHits);
                if (r.status !== 'ok') return r;
                const inner = r.node && r.node.t === 'arr' ? r.node.item : r.node;
                return { status: 'ok', node: { t: 'arr', item: inner, sure: cur.sure }, indexHits };
            }
            if (tok.type === 'match') {
                if (!cur.item) return { status: 'unknown', indexHits };
                if (cur.item.t === 'obj' && !cur.item.open && !cur.item.keys.has(tok.key)) {
                    return { status: 'broken', at: i, node: cur, reason: 'match-key', sure: sure && !!cur.item.sure };
                }
                cur = cur.item;
                continue;
            }
            if (isIndexKey(tok.key)) {
                if (cur.pairs) indexHits.push({ at: i, list: cur, index: Number(tok.key) });
                if (!cur.item) return { status: 'unknown', indexHits };
                cur = cur.item;
                continue;
            }
            if (tok.key === 'length') { cur = { t: 'num' }; continue; }
            return { status: 'broken', at: i, node: cur, reason: 'key-on-list', sure };
        }
        // An object.
        if (tok.type === 'wild' || tok.type === 'match') return { status: 'broken', at: i, node: cur, reason: 'not-list', sure };
        const key = String(tok.key);
        if (cur.keys.has(key)) { cur = cur.keys.get(key); continue; }
        if (cur.open) return { status: 'unknown', at: i, node: cur, indexHits };
        return { status: 'broken', at: i, node: cur, reason: 'missing', sure };
    }
    return { status: 'ok', node: cur, indexHits };
}

/** The node a path yields, or ANY when it does not resolve to something known. */
function nodeAt(node, tokens) {
    const r = walk(node, tokens);
    return r.status === 'ok' && r.node ? r.node : ANY;
}

/** What one entry of the list a node is looks like (ANY when not a known list). */
function itemOf(node) {
    if (!node || node.t !== 'arr') return ANY;
    return node.item || ANY;
}

// ── Finding paths ────────────────────────────────────────────────────────

/**
 * Every path under `node` whose last key is `want` (case-insensitively),
 * written with `prefix` in front, nearest first: where a field the AI named
 * actually lives. Lists are entered as `[0]` (or `[*]` with `wild`).
 */
function findKey(node, want, prefix, { wild = false, max = 3, maxDepth = 8 } = {}) {
    const hits = [];
    const lower = String(want).toLowerCase();
    let level = [{ node, path: prefix }];
    for (let d = 0; d < maxDepth && level.length && hits.length < max; d++) {
        const next = [];
        for (const { node: n, path } of level) {
            if (!n) continue;
            if (n.t === 'arr' && n.item) {
                // A name/value list holds the key as an entry NAME:
                // headers[name="Subject"].value is where "subject" lives.
                const name = pairNameFor(n, want);
                if (name && hits.length < max) hits.push(appendKey(appendMatch(path, n.pairs.nameKey, name), n.pairs.valueKey));
                next.push({ node: n.item, path: wild ? appendWildcard(path) : appendKey(path, 0) });
                continue;
            }
            if (n.t !== 'obj') continue;
            for (const [k, v] of n.keys) {
                const p = appendKey(path, k);
                if (k.toLowerCase() === lower && hits.length < max) hits.push(p);
                next.push({ node: v, path: p });
            }
        }
        level = next.slice(0, 400);
    }
    return hits;
}

/** The name/value entry names of a list node that match `want` case-insensitively. */
function pairNameFor(list, want) {
    if (!list || !list.pairs) return null;
    const lower = String(want).toLowerCase();
    const hits = list.pairs.names.filter(n => n.toLowerCase() === lower);
    return hits.length === 1 ? hits[0] : null;
}

// ── Rendering for the AI ─────────────────────────────────────────────────

const TYPE_WORD = { str: 'string', num: 'number', bool: 'boolean', null: 'null', any: 'any' };
const typeWord = n => (!n ? 'any' : n.t === 'num' && n.int ? 'integer' : (TYPE_WORD[n.t] || 'any'));

function renderNode(n, depth, maxDepth, maxKeys) {
    if (!n) return '[*] (empty list)';
    if (n.t === 'arr') {
        const item = n.item;
        if (!item) return '[*] (empty list)';
        if (item.t === 'arr') return `[*]${renderNode(item, depth, maxDepth, maxKeys)}`;
        if (item.t !== 'obj') return `[*]: ${typeWord(item)}`;
        let pairs = '';
        if (n.pairs) {
            const shown = n.pairs.names.slice(0, 6).map(x => (x.length > MAX_SHOWN_NAME ? `${x.slice(0, MAX_SHOWN_NAME)}…` : x));
            const example = n.pairs.names.find(x => x.length <= MAX_SHOWN_NAME);
            const pick = example ? `; pick one with ${appendMatch('', n.pairs.nameKey, example)}` : '';
            pairs = ` (${n.pairs.nameKey}/${n.pairs.valueKey} pairs: ${shown.join(', ')}${n.pairs.names.length > 6 ? ', …' : ''}${pick})`;
        }
        return `[*]: ${renderNode(item, depth, maxDepth, maxKeys)}${pairs}`;
    }
    if (n.t === 'obj') {
        if (!n.keys.size) return '{}';
        if (depth >= maxDepth) return '{…}';
        const entries = [...n.keys].slice(0, maxKeys).map(([k, v]) => renderMember(k, v, depth + 1, maxDepth, maxKeys));
        if (n.keys.size > maxKeys) entries.push(`…+${n.keys.size - maxKeys}`);
        return `{ ${entries.join(', ')} }`;
    }
    return typeWord(n);
}

function renderMember(k, v, depth, maxDepth, maxKeys) {
    const name = appendKey('', k);
    const json = v && v.json ? ' (JSON text)' : '';
    if (!v || v.t === 'str' || v.t === 'num' || v.t === 'bool' || v.t === 'null' || v.t === 'any') return name;
    if (v.t === 'arr') return `${name}${json}${renderNode(v, depth, maxDepth, maxKeys)}`;
    if (depth >= maxDepth) return `${name}${json}: {…}`;
    return `${name}${json}: ${renderNode(v, depth, maxDepth, maxKeys)}`;
}

/**
 * A compact, deep, one-line rendering of a shape for the AI, within
 * `maxChars`, in the run's own path grammar: nested objects as
 * `{ a, b: { c } }`, lists as `items[*]: { … }` (the union of every entry),
 * awkward keys quoted (`["content-type"]`), JSON text marked and shown with
 * its inner shape, top-level leaves with their type. When the full depth
 * does not fit, the depth is lowered until it does; the cut is `{…}`.
 *
 *   messages[*]: { id, payload: { headers[*]: { name, value }, parts[*]: { body: { data } } } }; resultSizeEstimate: number
 */
function renderShape(node, { maxChars = 900, maxDepth = 8, maxKeys = 24 } = {}) {
    if (!node) return null;
    const render = (d) => {
        if (node.t === 'obj') {
            const parts = [...node.keys].slice(0, maxKeys * 2).map(([k, v]) => {
                const name = appendKey('', k);
                if (!v || v.t === 'str' || v.t === 'num' || v.t === 'bool' || v.t === 'null' || v.t === 'any') return `${name}: ${typeWord(v)}`;
                return renderMember(k, v, 1, d, maxKeys);
            });
            if (node.keys.size > maxKeys * 2) parts.push(`…+${node.keys.size - maxKeys * 2} more`);
            return parts.join('; ') + (node.json ? ' (JSON text)' : '');
        }
        return `${renderNode(node, 0, d, maxKeys)}${node.json ? ' (JSON text)' : ''}`;
    };
    for (let d = maxDepth; d >= 1; d--) {
        const s = render(d);
        if (s.length <= maxChars || d === 1) return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
    }
    return null;
}

module.exports = {
    ANY,
    fromValue,
    fromDescriptor,
    fromCurated,
    fromDescription,
    merge,
    walk,
    nodeAt,
    itemOf,
    findKey,
    pairNameFor,
    renderShape,
    isIndexKey,
};
