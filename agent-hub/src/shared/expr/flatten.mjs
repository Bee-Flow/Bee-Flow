/**
 * "Flatten a list": one row for every item of a list inside a list, such as
 * one row per attachment with its email's details.
 *
 * The step stores a route (`steps.g.output.messages[*].attachments`) and a
 * COLUMN PLAN per level (`parents[i].fields: [{ from, to, mode }]`), made when
 * the step is designed (flattenPlan) and only applied by the run
 * (flattenRows), so a column never changes name between runs. A generic key
 * gets the item's name (`id` → `messageId`); a key the child carries with the
 * same value is a `fill` (written only where the child lacks it); a key the
 * child carries with another value is renamed, never overwritten.
 */

import { parsePath, formatPath, appendKey, appendWildcard, isIdentifierKey } from './path.mjs';
import { singularKey } from './rules.mjs';
import { nestedRows, itemVarFor, withSuffix, lastKey, isRecord, isScalar, RESERVED_VARS } from './nested.mjs';

/** Parent keys that hold long text: never copied onto every row by default. */
export const LONG_TEXT_KEYS = Object.freeze(new Set(['body', 'bodyhtml', 'html', 'text', 'textbody', 'content', 'raw', 'markdown', 'snippet', 'preview', 'description']));
/** A sample string longer than this is long text too, whatever its key. */
export const LONG_TEXT_CHARS = 1000;
/** Keys that mean nothing without their item's name: `id` becomes `messageId`. */
export const GENERIC_KEYS = Object.freeze(new Set(['id', 'name', 'type', 'value', 'status', 'email', 'address', 'key', 'label', 'title']));

const PLAN_SAMPLE_ROWS = 2000;
const SHAPE_SAMPLE_ROWS = 500;

/** A flatten's canonical route (a trailing `[*]` dropped), or null without a `[*]` before its last key. */
export function normalizeFlattenRoute(path) {
    const tokens = parsePath(path);
    if (!tokens) return null;
    while (tokens.length && tokens[tokens.length - 1].type === 'wild') tokens.pop();
    const firstWild = tokens.findIndex(t => t.type === 'wild');
    if (firstWild <= 0) return null;
    return formatPath(tokens);
}

/** The AI sugar: outer list + inner key (`…messages` + `attachments`) as one route; null without a key or after a `[*]`. */
export function routeFromParts(arrayRef, childField) {
    if (typeof childField !== 'string' || !childField.trim()) return null;
    const tokens = parsePath(arrayRef);
    if (!tokens || !tokens.length || tokens[tokens.length - 1].type === 'wild') return null;
    return appendKey(appendWildcard(formatPath(tokens)), childField.trim());
}

/** `message` + `id` → `messageId`; `order` + `due_date` → `order_due_date`. */
export function joinKey(prefix, key) {
    const k = String(key);
    if (!k) return prefix;
    if (k.includes('_') && k === k.toLowerCase()) return `${prefix}_${k}`;
    return `${prefix}${k[0].toUpperCase()}${k.slice(1)}`;
}

/** The variable one row's own item is called: `attachments` → `attachment`; `data` → `value`. */
export function childVarOf(route) {
    const key = lastKey(route);
    return singularKey(key) === key ? 'value' : itemVarFor(key);
}

/** The word for one row's own item in sentences and labels: `items` → `item` (childVarOf says `parent` there). */
export function childNounOf(route) {
    const key = lastKey(route);
    const noun = singularKey(key);
    return noun === key ? 'value' : noun;
}

/** The level `{ overRef, itemVar }` entries of a route, outermost first. */
export function defaultParents(route) {
    const tokens = parsePath(route);
    if (!tokens) return [];
    const taken = [childVarOf(route)];
    const out = [];
    tokens.forEach((t, i) => {
        if (t.type !== 'wild') return;
        const before = tokens.slice(0, i);
        const itemVar = itemVarFor(lastKey(before), taken);
        taken.push(itemVar);
        out.push({ overRef: formatPath(before), itemVar });
    });
    return out;
}

/** A child as a row: a record's own keys, or a plain value under the child's name. */
function childRow(item, childVar) {
    return isRecord(item) ? { ...item } : { [childVar]: item };
}

const sameValue = (a, b) => a === b
    || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => isScalar(v) && v === b[i]));

/** Why a parent key is left out of the plan by default, or null. */
function leftOutReason(key, values) {
    if (LONG_TEXT_KEYS.has(key.toLowerCase())) return 'long_text';
    for (const v of values) {
        if (Array.isArray(v)) { if (!v.every(isScalar)) return 'list'; continue; }
        if (v !== null && typeof v === 'object') return 'object';
        if (typeof v === 'string' && v.length > LONG_TEXT_CHARS) return 'long_text';
    }
    return null;
}

/** The record elements of one level in the sample, each once, in order. */
function levelElements(rows, level) {
    return [...new Set(rows.map(r => r.parents[level]).filter(isRecord))];
}

/** Every key of `elements` with its values, in first-seen order. */
function keyValues(elements) {
    const byKey = new Map();
    for (const el of elements) {
        for (const [k, v] of Object.entries(el)) (byKey.get(k) || byKey.set(k, []).get(k)).push(v);
    }
    return byKey;
}

/** True when every sample row with both values known has the same one (and one does). */
function fillsChild(pairs, level, from, to) {
    let both = 0;
    for (const { row, parents } of pairs) {
        const p = parents[level];
        if (!isRecord(p) || p[from] === undefined || row[to] === undefined) continue;
        // A sample built from a shape has null everywhere: two nulls prove nothing.
        if (p[from] === null && row[to] === null) continue;
        if (!sameValue(row[to], p[from])) return false;
        both++;
    }
    return both > 0;
}

/** Name one parent key against the child's keys and the plan so far (F9-F12). */
function planEntry(ctx, level, itemVar, from) {
    const base = GENERIC_KEYS.has(from.toLowerCase()) ? joinKey(itemVar, from) : from;
    const taken = (k) => ctx.childKeys.has(k) || ctx.planned.has(k);
    if (!taken(base)) return { from, to: base, mode: 'copy' };
    if (ctx.childKeys.has(base) && !ctx.planned.has(base) && fillsChild(ctx.pairs, level, from, base)) {
        return { from, to: base, mode: 'fill' };
    }
    const to = withSuffix(base === from ? joinKey(itemVar, from) : base, taken);
    ctx.clashes.push({ level, from, to });
    return { from, to, mode: 'copy' };
}

/** The candidate keys of one level, and the ones left out with a reason. */
function candidatesOf(ctx, level, nextKey, keepFields) {
    const byKey = keyValues(levelElements(ctx.rows, level));
    byKey.delete(nextKey);
    if (Array.isArray(keepFields)) {
        const keep = keepFields.filter(k => typeof k === 'string' && byKey.has(k));
        ctx.unknown.push(...keepFields.filter(k => typeof k === 'string' && !byKey.has(k)));
        const fillOnly = [...byKey.keys()].filter(k => !keep.includes(k) && !leftOutReason(k, byKey.get(k)));
        return { keep, fillOnly };
    }
    const keep = [];
    for (const [k, values] of byKey) {
        const reason = leftOutReason(k, values);
        if (reason) ctx.left.push({ level, key: k, reason });
        else keep.push(k);
    }
    return { keep, fillOnly: [] };
}

/** Plan `keys` onto `fields`; with `fillOnly`, only the keys that come out as a fill. */
function addEntries(ctx, level, itemVar, keys, fields, fillOnly) {
    const known = new Set(fields.map(f => f.from));
    for (const from of keys) {
        if (known.has(from)) continue;
        const clashes = ctx.clashes.length;
        const e = planEntry(ctx, level, itemVar, from);
        if (fillOnly && e.mode !== 'fill') { ctx.clashes.length = clashes; continue; }
        ctx.planned.add(e.to);
        fields.push(e);
    }
}

/** Plan one level: prior entries as they are, then the new keys. */
function planLevel(ctx, level, def, opts) {
    const prior = opts.prior?.[level];
    const itemVar = typeof prior?.itemVar === 'string' && prior.itemVar ? prior.itemVar : def.itemVar;
    const fields = (Array.isArray(prior?.fields) ? prior.fields : []).filter(f => f && typeof f.to === 'string').map(f => ({ ...f }));
    for (const f of fields) ctx.planned.add(f.to);
    const { keep, fillOnly } = candidatesOf(ctx, level, def.nextKey, opts.keepFields);
    addEntries(ctx, level, itemVar, keep, fields, false);
    addEntries(ctx, level, itemVar, fillOnly, fields, true);
    let auto = typeof prior?.auto === 'boolean' ? prior.auto : true;
    if (Array.isArray(opts.keepFields)) auto = false;
    return { overRef: def.overRef, itemVar, auto, fields };
}

/**
 * The column plan for `route` from the sample `root`: `parents` (outermost first), what was `left`
 * out, the renamed `clashes` and the `unknown` keepFields. Levels are named nearest first.
 * `keepFields` names the nearest level's keys (plus fills); `prior` is kept and only appended to.
 * @param {unknown} root
 * @param {string} route
 * @param {{ keepFields?: string[] | null, prior?: any[] | null }} [opts]
 */
export function flattenPlan(root, route, { keepFields = null, prior = null } = {}) {
    const canonical = normalizeFlattenRoute(route);
    const empty = { parents: [], left: [], clashes: [], unknown: [] };
    if (!canonical) return empty;
    const childVar = childVarOf(canonical);
    const defs = defaultParents(canonical);
    const tokens = parsePath(canonical);
    const wilds = tokens.flatMap((t, i) => (t.type === 'wild' ? [i] : []));
    defs.forEach((d, i) => { d.nextKey = String(tokens[wilds[i] + 1]?.key ?? ''); });
    const nr = nestedRows(root, canonical, { keepEmpty: true, limit: PLAN_SAMPLE_ROWS });
    const rows = nr ? nr.rows : [];
    const pairs = rows.filter(r => !r.empty).map(r => ({ row: childRow(r.item, childVar), parents: r.parents }));
    const childKeys = new Set(pairs.flatMap(p => Object.keys(p.row)));
    const ctx = { rows, pairs, childKeys, planned: new Set(), left: [], clashes: [], unknown: [] };
    const parents = new Array(defs.length);
    for (let level = defs.length - 1; level >= 0; level--) {
        const opts = { prior, keepFields: level === defs.length - 1 ? keepFields : null };
        parents[level] = planLevel(ctx, level, defs[level], opts);
    }
    return { parents, left: ctx.left, clashes: ctx.clashes, unknown: ctx.unknown };
}

/** The plan to apply: the stored fields per level, or one made from this data (F28). */
function appliedPlan(root, route, step) {
    const stored = Array.isArray(step?.parents) ? step.parents : [];
    const levels = defaultParents(route).length;
    let made = null;
    const out = [];
    for (let i = 0; i < levels; i++) {
        if (Array.isArray(stored[i]?.fields)) { out.push(stored[i].fields); continue; }
        made = made || flattenPlan(root, route);
        out.push(made.parents[i]?.fields || []);
    }
    return out;
}

/** Write one level's planned parent fields onto a row. */
function applyLevel(row, parent, fields, ctx) {
    if (!isRecord(parent)) return;
    for (const f of fields) {
        if (!f || typeof f.to !== 'string') continue;
        const value = parent[f.from] ?? null;
        if (f.mode === 'fill') {
            if (ctx.empty || row[f.to] === undefined) row[f.to] = value;
            continue;
        }
        if (!ctx.empty && ctx.own.has(f.to)) {
            const moved = withSuffix(joinKey(ctx.childNoun, f.to), (k) => k in row);
            row[moved] = row[f.to];
            ctx.clash(f.to, moved);
        }
        row[f.to] = value;
    }
}

const clashWarning = (clashes) => [...clashes.entries()]
    .map(([to, c]) => `${c.n} rows had a field called ${to} on the item itself; it is kept as ${c.moved}.`).join(' ');

/**
 * The rows of a flatten step over `root`, as the run makes them:
 * `{ items, count, inputCount, emptyCount, warning?, dead, over }`, or null
 * when the outermost list does not resolve (or the route has no level).
 * A row is the child's own keys, then the planned parent fields, nearest
 * level first. Callers map `dead` to a skip and `over` to the size error.
 */
export function flattenRows(root, step, { limit = Infinity } = {}) {
    const route = normalizeFlattenRoute(step?.arrayRef);
    if (!route) return null;
    const nr = nestedRows(root, route, { keepEmpty: !!step.keepEmpty, limit });
    if (!nr) return null;
    const childVar = childVarOf(route);
    const childNoun = childNounOf(route);
    const plan = appliedPlan(root, route, step);
    const childCols = [...new Set(nr.rows.filter(r => !r.empty).flatMap(r => Object.keys(childRow(r.item, childVar))))];
    const clashes = new Map();
    const clash = (to, moved) => clashes.set(to, { n: (clashes.get(to)?.n || 0) + 1, moved: clashes.get(to)?.moved || moved });
    const items = nr.rows.map((r) => {
        const row = r.empty ? Object.fromEntries(childCols.map(k => [k, null])) : childRow(r.item, childVar);
        const ctx = { empty: r.empty, own: new Set(Object.keys(row)), childNoun, clash };
        for (let level = plan.length - 1; level >= 0; level--) applyLevel(row, r.parents[level], plan[level], ctx);
        return row;
    });
    const warning = clashWarning(clashes);
    const out = { items, count: items.length, inputCount: nr.inputCount, emptyCount: nr.emptyCount, ...(warning ? { warning } : {}) };
    // With keepEmpty, parents that lack the list (Outlook leaves `attachments` out) are the rows asked for.
    return Object.assign(out, { dead: nr.dead && !step.keepEmpty, over: nr.over });
}

/**
 * One merged record of the rows a flatten makes from the sample: every row
 * key in row order, each with its first non-null value. What the field
 * pickers and the server's shape inference read before a run.
 */
export function flattenShape(root, step) {
    const shape = {};
    for (const row of flattenRows(root, step, { limit: SHAPE_SAMPLE_ROWS })?.items || []) {
        for (const [k, v] of Object.entries(row)) if (!(k in shape) || (shape[k] === null && v !== null)) shape[k] = v;
    }
    return shape;
}

const validField = (f) => isRecord(f) && (f.mode === 'copy' || f.mode === 'fill') && typeof f.from === 'string' && f.from !== ''
    && typeof f.to === 'string' && f.to !== '' && f.to.length <= 200 && f.to.trim() === f.to;

/** Why one stored level is invalid, or null. */
function levelProblem(p, expected, vars, childVar, tos) {
    if (!isRecord(p)) return 'count';
    const pt = parsePath(typeof p.overRef === 'string' ? p.overRef : '');
    if (!pt || formatPath(pt) !== expected.overRef) return 'overRef';
    const v = p.itemVar;
    if (!isIdentifierKey(v) || RESERVED_VARS.includes(v) || v === childVar || vars.has(v)) return 'itemVar';
    vars.add(v);
    if (p.fields === undefined) return null;
    if (!Array.isArray(p.fields)) return 'fields';
    for (const f of p.fields) {
        if (!validField(f) || tos.has(f.to)) return 'fields';
        tos.add(f.to);
    }
    return null;
}

/**
 * Null when a flatten step's stored `parents` fit its route, else why not:
 * `count` (not one entry per `[*]`), `overRef` (not the route up to its
 * `[*]`), `itemVar` (not a name, reserved, the child's or repeated) or
 * `fields` (a malformed entry, or two entries with the same `to`).
 */
export function checkFlattenParents(step) {
    const route = normalizeFlattenRoute(step?.arrayRef);
    if (!route || step.parents === undefined || step.parents === null) return null;
    if (!Array.isArray(step.parents)) return 'count';
    const defs = defaultParents(route);
    if (step.parents.length !== defs.length) return 'count';
    const vars = new Set();
    const tos = new Set();
    const childVar = childVarOf(route);
    for (let i = 0; i < defs.length; i++) {
        const problem = levelProblem(step.parents[i], defs[i], vars, childVar, tos);
        if (problem) return problem;
    }
    return null;
}

const PASS_THROUGH = new Set(['filter', 'limit', 'dedupe']);

/** `steps.<id>.output.items` (optionally `[*]`) → `<id>`, else null. */
function itemsStepId(tokens) {
    if (!tokens || tokens.length < 4 || tokens.length > 5) return null;
    const [s, id, o, items, wild] = tokens;
    if (s.key !== 'steps' || o.key !== 'output' || items.key !== 'items' || typeof id.key !== 'string') return null;
    if (wild && wild.type !== 'wild') return null;
    return id.key;
}

/** The plural key naming a list path's rows: a flatten's by its route, a filter/limit/dedupe's by its source, else the last key. */
export function listNounKey(definition, path) {
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];
    for (let hop = 0, current = path; hop < 8; hop++) {
        const tokens = parsePath(current);
        if (!tokens) return null;
        const id = itemsStepId(tokens);
        const step = id ? steps.find(s => s && s.id === id) : null;
        if (step?.type === 'flatten') return lastKey(normalizeFlattenRoute(step.arrayRef) || '') || null;
        if (!step || !PASS_THROUGH.has(step.type) || typeof step.arrayRef !== 'string') return lastKey(tokens) || null;
        current = step.arrayRef;
    }
    return null;
}

/** `lineItems` → `line items`; `due_date` → `due date`. */
function humanKey(key) {
    let out = '';
    const s = String(key ?? '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const upper = c >= 'A' && c <= 'Z';
        if (c === '_' || c === '-') { out += ' '; continue; }
        if (upper && i > 0 && !(s[i - 1] >= 'A' && s[i - 1] <= 'Z')) out += ' ';
        out += c.toLowerCase();
    }
    return out.trim();
}

/** The parts of a flatten's run sentence: which one (`made`, `empty`, `no_match`), the counts, and the data's nouns, humanised. */
export function flattenSentenceParts(output, step) {
    const route = normalizeFlattenRoute(step?.arrayRef) || '';
    const tokens = parsePath(route) || [];
    const firstWild = tokens.findIndex(t => t.type === 'wild');
    const outerKey = firstWild > 0 ? lastKey(tokens.slice(0, firstWild)) : '';
    const o = isRecord(output) ? output : {};
    const inputCount = Number(o.inputCount) || 0;
    const kind = o.skipped ? 'no_match' : (inputCount === 0 ? 'empty' : 'made');
    return {
        kind, count: Number(o.count) || 0, inputCount, emptyCount: Number(o.emptyCount) || 0, keepEmpty: !!step?.keepEmpty,
        parents: humanKey(outerKey), children: humanKey(lastKey(tokens)), child: humanKey(route ? childNounOf(route) : ''),
    };
}
