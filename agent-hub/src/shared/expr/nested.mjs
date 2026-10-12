/**
 * Lists inside lists: the walks that keep the element each item came from.
 *
 * `walkTrail`, `listOf`, `sameToken` and `parentDepths` are the forEach trail
 * walk (moved here verbatim from server/core/automationRunner/forEachScope.js,
 * which imports them back): a step that runs once per attachment can still
 * read the email each attachment came from (`forEach.parents`).
 *
 * `nestedRows` and `routeLevels` serve "Flatten a list" (flatten.mjs) and the
 * Condition node's level chooser. A ROUTE is an ordinary path with one `[*]`
 * per level: `steps.g.output.messages[*].attachments` is "every attachment of
 * every message". The same functions answer the editor's preview, the web and
 * phone describers and the run, so what the editor counts is what the run makes.
 */

import { parsePath, formatPath, appendKey, appendWildcard, walkTokens, stepInto, stepMatch, parseJsonText, jsonCacheFor } from './path.mjs';
import { singularKey } from './rules.mjs';

/**
 * The list a `[*]` iterates: an array, or JSON text that encodes one (as
 * walkTokens). `cache` is the run's JSON-text cache (jsonCacheFor), the one
 * walkPath already filled for the same overRef: a large body is parsed once
 * per run, not once more here.
 */
export function listOf(cur, cache = null) {
    const list = typeof cur === 'string' ? parseJsonText(cur, cache) : cur;
    return Array.isArray(list) ? list : null;
}

/**
 * Walk `tokens` like walkTokens, but return every resulting element with its
 * TRAIL: `trail[j]` is the value reached after token j on the way to it (for a
 * `[*]`, the element taken). Returns `{ entries, dead }` or undefined when the
 * path does not resolve at all. `entries` is null when the result is not a
 * list. `dead` is true when some `[*]` had elements and the rest of the path
 * resolved on none of them: the path does not fit the data, which is a
 * different thing from a list that is empty.
 */
export function walkTrail(tokens, root) {
    const cache = jsonCacheFor(root);
    const rec = (t, cur, trail) => {
        if (t === tokens.length) return { value: cur, trail };
        const tok = tokens[t];
        if (tok.type === 'wild') {
            const list = listOf(cur, cache);
            if (!list) return undefined;
            const entries = [];
            if (t === tokens.length - 1) {
                for (const el of list) if (el !== undefined) entries.push({ value: el, trail: [...trail, el] });
                return { entries, dead: false };
            }
            let resolved = 0;
            for (const el of list) {
                const m = rec(t + 1, el, [...trail, el]);
                if (m === undefined) continue;
                if (m.entries) {
                    if (!m.dead) resolved++;
                    entries.push(...m.entries);
                    continue;
                }
                resolved++;
                if (Array.isArray(m.value)) for (const v of m.value) entries.push({ value: v, trail: m.trail });
                else entries.push(m);
            }
            return { entries, dead: list.length > 0 && resolved === 0 };
        }
        const next = tok.type === 'match' ? stepMatch(cur, tok.key, tok.value, cache) : stepInto(cur, tok.key, cache);
        if (next === undefined) return undefined;
        return rec(t + 1, next, [...trail, next]);
    };
    const r = rec(0, root, []);
    if (r === undefined) return undefined;
    if (r.entries) return r;
    if (Array.isArray(r.value)) return { entries: r.value.map(v => ({ value: v, trail: r.trail })), dead: false };
    return { entries: null, dead: false };
}

export const sameToken = (a, b) => a && b && a.type === b.type
    && (a.type === 'wild' || (a.key === b.key && (a.type !== 'match' || a.value === b.value)));

/**
 * The usable `forEach.parents` entries with the trail position of each: a
 * parent whose overRef is not a leading part of `tokens`, or whose itemVar
 * clashes, is left out (the validator reports it; iterationRules.js).
 */
export function parentDepths(parents, tokens, itemVar) {
    if (!Array.isArray(parents)) return [];
    const out = [];
    const seen = new Set([itemVar]);
    for (const p of parents) {
        if (!p || typeof p.itemVar !== 'string' || !p.itemVar || seen.has(p.itemVar) || typeof p.overRef !== 'string') continue;
        const pt = parsePath(p.overRef);
        if (!pt || pt.length >= tokens.length || !pt.every((tok, i) => sameToken(tok, tokens[i]))) continue;
        // The parent element sits right after the parent's own path — or, when
        // the step's path goes on with `[*]`, it is the element taken there.
        const depth = tokens[pt.length].type === 'wild' ? pt.length + 1 : pt.length;
        seen.add(p.itemVar);
        out.push({ itemVar: p.itemVar, at: depth - 1 });
    }
    return out;
}

// ── Rows of a list inside a list ─────────────────────────────────────────

/** A plain record: an object that is not a list. */
export function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The rows one level of a route holds: a list, JSON text of one, or a single record as
 * `[record]` (XML-to-JSON gives an object for one line). Anything else gives null.
 */
export function asRows(value, cache = null) {
    const list = listOf(value, cache);
    if (list) return list;
    return isRecord(value) ? [value] : null;
}

/** Names a step's item variable may not take: they mean something already. */
export const RESERVED_VARS = Object.freeze(['item', 'loop', 'steps', 'trigger', 'true', 'false', 'null', '_index']);

const isIdentChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';

/**
 * The variable one element of the list `key` is called: `messages` gives
 * `message`, `lineItems` gives `lineItem`. Characters a name cannot hold
 * become `_`, a leading digit gets a `_` in front, an empty or reserved name
 * becomes `parent` (so `items` gives `parent`), and a name in `taken` gets
 * a number: `message2`.
 */
export function itemVarFor(key, taken = []) {
    let s = '';
    for (const c of singularKey(String(key ?? ''))) s += isIdentChar(c) ? c : '_';
    if (s[0] >= '0' && s[0] <= '9') s = `_${s}`;
    if (!s || RESERVED_VARS.includes(s)) s = 'parent';
    return withSuffix(s, (v) => taken.includes(v));
}

/** `base`, or `base2`, `base3`, … : the first one `isTaken` does not claim. */
export function withSuffix(base, isTaken) {
    if (!isTaken(base)) return base;
    let n = 2;
    while (isTaken(`${base}${n}`)) n++;
    return `${base}${n}`;
}

/** A route cut at each `[*]`: `segments[0]` leads to the outermost list, `segments[i]` from a level-(i-1) element on; null without `[*]`. */
export function splitRoute(path) {
    const tokens = parsePath(path);
    if (!tokens || !tokens.some(t => t.type === 'wild')) return null;
    const segments = [[]];
    for (const t of tokens) {
        if (t.type === 'wild') segments.push([]);
        else segments[segments.length - 1].push(t);
    }
    return { segments, levels: segments.length - 1 };
}

/** One wildcard-free segment from `cur`, sharing the run's JSON-text cache. */
function walkSegment(tokens, cur, cache) {
    let v = cur;
    for (const tok of tokens) {
        const prev = v;
        v = tok.type === 'match' ? stepMatch(v, tok.key, tok.value, cache) : stepInto(v, tok.key, cache);
        if (v === undefined && tok.alt !== undefined) v = stepInto(prev, tok.alt, cache);
        if (v === undefined) return undefined;
    }
    return v;
}

/** The walk state nestedRows threads through its levels. */
function walker(segments, keepEmpty, limit, cache) {
    const depth = segments.length - 1;
    // reached[l] / hit[l]: elements that level l's segment was read from, and the ones it resolved on.
    const st = { rows: [], emptyCount: 0, reached: new Array(depth + 1).fill(0), hit: new Array(depth + 1).fill(0), over: false };
    const push = (row) => {
        if (st.rows.length >= limit) { st.over = true; return; }
        st.rows.push(row);
    };
    const empty = (parents, level) => {
        if (level === depth) st.emptyCount++;
        if (keepEmpty) push({ item: undefined, parents: [...parents, ...new Array(depth - parents.length)], empty: true });
    };
    const visit = (level, parents) => {
        if (st.over) return;
        const value = walkSegment(segments[level], parents[parents.length - 1], cache);
        st.reached[level]++;
        if (value !== undefined) st.hit[level]++;
        const kids = (asRows(value, cache) || []).filter(el => el !== null && el !== undefined);
        if (!kids.length) { empty(parents, level); return; }
        for (const el of kids) {
            if (st.over) return;
            if (level === depth) push({ item: el, parents, empty: false });
            else visit(level + 1, [...parents, el]);
        }
    };
    return { st, push, visit };
}

/**
 * Every innermost item of `route` with the element of each level it came from (`parents[i]`):
 * `{ rows: [{ item, parents, empty }], inputCount, emptyCount, dead, over }`, or null when the
 * outermost list does not resolve. An innermost parent without children counts in `emptyCount`;
 * with `keepEmpty`, any parent whose next level is empty gives one `empty` row. `dead`: some level
 * of the route resolved on none of the elements it was read from (the route fits nothing there).
 * `over`: more than `limit` rows; `rows` stops at `limit`.
 */
export function nestedRows(root, route, { keepEmpty = false, limit = Infinity } = {}) {
    const split = splitRoute(route);
    if (!split) return null;
    const segments = split.segments.slice();
    if (!segments[segments.length - 1].length) segments.pop();
    const cache = jsonCacheFor(root);
    const outer = asRows(walkSegment(segments[0], root, cache), cache);
    if (!outer) return null;
    const { st, push, visit } = walker(segments, keepEmpty, limit, cache);
    for (const el of outer) {
        if (st.over) break;
        if (el === null || el === undefined) continue;
        if (segments.length === 1) push({ item: el, parents: [], empty: false });
        else visit(1, [el]);
    }
    const dead = outer.length > 0 && st.reached.some((n, l) => n > 0 && st.hit[l] === 0);
    return { rows: st.rows, inputCount: outer.length, emptyCount: st.emptyCount, dead, over: st.over };
}

/** The last key of a path (`attachments` of `…messages[*].attachments`), or ''. */
export function lastKey(path) {
    const tokens = Array.isArray(path) ? path : parsePath(path);
    if (!tokens) return '';
    const last = [...tokens].reverse().find(t => t.type !== 'wild');
    return last ? String(last.key) : '';
}

export const isScalar = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');

/** The inner lists of `elements`, by key, in first-seen order. */
function innerLists(elements, cache) {
    const byKey = new Map();
    for (const el of elements) {
        if (!isRecord(el)) continue;
        for (const [k, v] of Object.entries(el)) {
            const list = listOf(v, cache);
            if (list && !byKey.has(k)) byKey.set(k, true);
        }
    }
    return [...byKey.keys()];
}

/** One level under `elements` through `key`: its counts and its children. */
function levelOf(elements, key, cache) {
    const children = [];
    let outerCount = 0;
    for (const el of elements) {
        if (!isRecord(el)) continue;
        const kids = (asRows(stepInto(el, key, cache), cache) || []).filter(v => v !== null && v !== undefined);
        if (kids.length) outerCount++;
        children.push(...kids);
    }
    const records = children.length > 0 && children.every(isRecord);
    return { children, outerCount, records };
}

function levelsUnder(elements, base, depth, taken, maxDepth, cache, out) {
    for (const key of innerLists(elements, cache)) {
        const path = appendKey(appendWildcard(base), key);
        const itemVar = itemVarFor(key, taken);
        const { children, outerCount, records } = levelOf(elements, key, cache);
        out.push({ path, key, itemVar, count: children.length, outerCount, depth, records });
        if (records && depth < maxDepth) levelsUnder(children, path, depth + 1, [...taken, itemVar], maxDepth, cache, out);
    }
}

/**
 * The levels to make rows from, starting at the list `source` (entry 0, `depth: 0`): every key
 * whose value on some element is a list, as a route (`source[*].attachments`) with `count`,
 * `outerCount` (elements with a child) and `records`, down to `maxDepth`. Empty when no list.
 */
export function routeLevels(source, root, { maxDepth = 1 } = {}) {
    const tokens = parsePath(source);
    if (!tokens) return [];
    const cache = jsonCacheFor(root);
    const list = asRows(walkTokens(tokens, root), cache);
    if (!list) return [];
    const key = lastKey(tokens);
    const itemVar = itemVarFor(key);
    const present = list.filter(v => v !== null && v !== undefined);
    const out = [{
        path: formatPath(tokens), key, itemVar, count: list.length, outerCount: null, depth: 0,
        records: present.length > 0 && present.every(isRecord),
    }];
    if (maxDepth >= 1) levelsUnder(present, formatPath(tokens), 1, [itemVar], maxDepth, cache, out);
    return out;
}

