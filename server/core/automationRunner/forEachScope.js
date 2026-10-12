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
 * The item list itself is still `walkPath(overRef)`: the trail walk
 * (shared/expr/nested.mjs walkTrail) mirrors shared/expr/path.mjs walkTokens
 * step for step and only records the trail.
 */

// The trail walk lives in shared/expr/nested.mjs (flatten.mjs walks lists
// inside lists the same way); this file binds what it finds to a forEach.
const { parsePath, formatPath, walkTokens, jsonCacheFor, listOf, walkTrail, parentDepths } = require('../../automation/expr');

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
    const walked = walkTrail(tokens, runState);
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

module.exports = { resolveForEachItems, walkWithTrail: walkTrail, parentDepths };
