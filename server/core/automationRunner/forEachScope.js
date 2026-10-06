/**
 * The items a "run once per item" step works through, and — for a list
 * INSIDE a list — which outer element each item belongs to.
 *
 * A step that ran once per email (`loop.result`) and is moved to run once per
 * attachment (the builder's "deepen", agent-hub mapping/deepenForEach.ts)
 * iterates the flattened `steps.read.output.results[*].output.attachments`.
 * Flattening loses the email each attachment came from, so a field that read
 * the email (`loop.result.id`) either pointed at nothing or was rebound to a
 * same-named field of the attachment, which is not the same thing.
 *
 * `forEach.parents` keeps it: the outer lists, outermost first, each as
 * `{ itemVar, overRef }` with the itemVar and overRef that level had before
 * the move. Every parent overRef is a leading part of the step's own overRef,
 * so walking the step's overRef passes through the parent element on the way
 * to each item; that element is bound as `loop.<parent itemVar>` beside
 * `loop.<itemVar>`. The old variable keeps exactly the value it had, and
 * every field that read it keeps its meaning.
 *
 * The item list itself is still `walkPath(overRef)`: this walk mirrors
 * shared/expr/path.mjs walkTokens step for step and only records the trail.
 */

const { parsePath, formatPath, walkTokens, stepInto, stepMatch, parseJsonText, jsonCacheFor } = require('../../automation/expr');

/**
 * The list a `[*]` iterates: an array, or JSON text that encodes one (as
 * walkTokens). `cache` is the run's JSON-text cache (jsonCacheFor), the one
 * walkPath already filled for the same overRef: a large body is parsed once
 * per run, not once more here.
 */
function listOf(cur, cache = null) {
    if (Array.isArray(cur)) return cur;
    if (typeof cur === 'string') {
        const parsed = parseJsonText(cur, cache);
        if (Array.isArray(parsed)) return parsed;
    }
    return null;
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
function walkWithTrail(tokens, root) {
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

const sameToken = (a, b) => a && b && a.type === b.type
    && (a.type === 'wild' || (a.key === b.key && (a.type !== 'match' || a.value === b.value)));

/**
 * The usable `forEach.parents` entries with the trail position of each: a
 * parent whose overRef is not a leading part of `tokens`, or whose itemVar
 * clashes, is left out (the validator reports it; iterationRules.js).
 */
function parentDepths(parents, tokens, itemVar) {
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

/**
 * Resolve a forEach. Returns:
 *   list    — exactly what walkPath(overRef) gives (undefined, a non-list, or the items)
 *   scopes  — per item, the parent variables to bind (`{ result: <email> }`), or null
 *   noMatch — `{ outer, count }` when the overRef has `[*]`, the outer list
 *             (`outer`, `count` elements) has elements and the path matched none
 *             of them (`orders[*].line_items.properties`): an empty list that is
 *             a broken path, not an empty source. Null otherwise.
 */
function resolveForEachItems(fe, runState, list) {
    const tokens = parsePath(String(fe?.overRef || ''));
    if (!tokens || !Array.isArray(list)) return { scopes: null, noMatch: null };
    const firstWild = tokens.findIndex(t => t.type === 'wild');
    const parents = parentDepths(fe.parents, tokens, fe.itemVar || 'item');
    if (firstWild < 0 || (!parents.length && list.length)) return { scopes: null, noMatch: null };
    const walked = walkWithTrail(tokens, runState);
    if (!walked || !walked.entries) return { scopes: null, noMatch: null };
    let noMatch = null;
    if (list.length === 0 && walked.dead) {
        const outer = formatPath(tokens.slice(0, firstWild));
        noMatch = { outer, count: (listOf(walkTokens(tokens.slice(0, firstWild), runState), jsonCacheFor(runState)) || []).length };
    }
    // Same walk, so the same elements; if that ever stopped holding, binding a
    // parent to the wrong item would be worse than binding none.
    if (!parents.length || walked.entries.length !== list.length) return { scopes: null, noMatch };
    const scopes = walked.entries.map(e => Object.fromEntries(parents.map(p => [p.itemVar, e.trail[p.at]])));
    return { scopes, noMatch };
}

module.exports = { resolveForEachItems, walkWithTrail, parentDepths };
