/**
 * The last line of defence after capture: does a payload still name a real id?
 *
 * The pointer registry (pointers.js) rewrites every pointer it KNOWS about.
 * What it cannot see is an id written somewhere nobody registered: inside a
 * code step's source, in a template string, in a webpage's JavaScript, in a
 * field a builder added last month. In a stage that id still resolves, to the
 * Dev part, so a UAT automation would quietly read Dev's table. This sweep finds
 * every such id by searching the serialised payloads for each member id as a
 * whole token. A pipeline release treats a hit as blocking; a gallery export
 * reports it.
 *
 * One kind of hit is repairable: a literal datatable id (`tbl_` + 12 hex) in
 * webpage code. Those are substituted by whole token at deploy time
 * (substituteTableTokens), and every substitution is listed in the plan.
 */

'use strict';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** One regex for all ids, longest first so an id never matches inside a longer one. */
function idPattern(ids) {
    const alternation = [...ids].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    return new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, 'g');
}

function pathOf(base, key) {
    if (typeof key === 'number') return `${base}[${key}]`;
    return base ? `${base}.${key}` : String(key);
}

/** Visit every string (values AND object keys) with the path it sits at. */
function walkStrings(node, path, fn) {
    if (typeof node === 'string') { fn(node, path); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walkStrings(v, pathOf(path, i), fn)); return; }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
        fn(k, pathOf(path, k) + '#key');
        walkStrings(v, pathOf(path, k), fn);
    }
}

/** `entities` is a manifest's `solution.entities` (kind → list) or a plain list. */
function entityList(entities) {
    if (Array.isArray(entities)) return entities;
    if (!isObject(entities)) return [];
    return Object.values(entities).flatMap(list => (Array.isArray(list) ? list : []));
}

/**
 * Every real member id that still appears in a captured payload.
 *
 * @param {object|object[]} entities   captured entities, each with its `ref`
 * @param {Iterable<string>} memberIds the real ids of every member
 * @returns {{ref: string|null, path: string, id: string}[]}
 */
function sweepRawIds(entities, memberIds) {
    const ids = new Set();
    for (const id of memberIds || []) if (typeof id === 'string' && id.length >= 3) ids.add(id);
    if (!ids.size) return [];
    const pattern = idPattern(ids);
    const hits = [];
    for (const entity of entityList(entities)) {
        if (!isObject(entity)) continue;
        const ref = typeof entity.ref === 'string' ? entity.ref : null;
        const seen = new Set();
        walkStrings(entity, '', (text, path) => {
            if (path === 'ref') return;
            for (const m of text.matchAll(pattern)) {
                const key = `${path}\u0000${m[0]}`;
                if (seen.has(key)) continue;
                seen.add(key);
                hits.push({ ref, path, id: m[0] });
            }
        });
    }
    return hits;
}

/** A datatable id as `newDatatableId` mints it: `tbl_` + 12 hex. */
const TABLE_TOKEN = /(?<![A-Za-z0-9_])tbl_[0-9a-f]{12}(?![A-Za-z0-9_])/g;

/**
 * Replace every whole-token `tbl_<12 hex>` that `idMap` knows. Tokens it does
 * not know are left alone, and so is anything that merely CONTAINS a token
 * (`tbl_…_backup`, `xtbl_…`).
 *
 * @param {string} source
 * @param {Map<string,string>|Object<string,string>} idMap  old id → new id
 * @returns {{text: string, substitutions: {from: string, to: string, count: number}[]}}
 */
function substituteTableTokens(source, idMap) {
    if (typeof source !== 'string') return { text: source, substitutions: [] };
    const get = (id) => (idMap instanceof Map ? idMap.get(id)
        : (isObject(idMap) && Object.prototype.hasOwnProperty.call(idMap, id) ? idMap[id] : undefined));
    const counts = new Map();
    const text = source.replace(TABLE_TOKEN, (token) => {
        const to = get(token);
        if (typeof to !== 'string' || !to) return token;
        counts.set(token, { to, count: (counts.get(token)?.count || 0) + 1 });
        return to;
    });
    return { text, substitutions: [...counts].map(([from, { to, count }]) => ({ from, to, count })) };
}

/** True when `id` has the exact shape substituteTableTokens rewrites. */
function isTableToken(id) {
    return typeof id === 'string' && /^tbl_[0-9a-f]{12}$/.test(id);
}

module.exports = { sweepRawIds, substituteTableTokens, isTableToken };
