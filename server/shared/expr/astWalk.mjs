// @typecheck strict
/**
 * Read-only walks over a parsed expression (engine.mjs parseExpr): the roots it
 * reads, the host calls a caller must answer first, the list functions and
 * whether a body reads its item. Each visits the same keys in source order.
 */

/**
 * A parsed node, as far as these walks look at it.
 * @typedef {{
 *   kind: string, name?: string, v?: unknown,
 *   a?: ExprNode, b?: ExprNode, cond?: ExprNode, expr?: ExprNode,
 *   segments?: Array<{ kind: string, v?: unknown, expr?: ExprNode }>,
 *   args?: ExprNode[],
 * }} ExprNode
 * @typedef {ExprNode & { name: string, args: ExprNode[] }} ExprCallNode a call, host call or list function
 */

/** The keys of a node that hold one sub-expression. */
const SUB_KEYS = /** @type {const} */ (['cond', 'a', 'b', 'expr']);
/** collectRefs's order (kept from before the split; the set does not care). */
const REF_KEYS = /** @type {const} */ (['a', 'b', 'cond', 'expr']);

/**
 * The direct sub-expressions of a node, in source order.
 * @param {ExprNode} node
 * @param {ReadonlyArray<'cond' | 'a' | 'b' | 'expr'>} [keys]
 * @returns {ExprNode[]}
 */
function childNodes(node, keys = SUB_KEYS) {
    /** @type {ExprNode[]} */
    const out = [];
    for (const key of keys) { const child = node[key]; if (child) out.push(child); }
    if (node.segments) for (const s of node.segments) if (s.expr) out.push(s.expr);
    if (node.args) out.push(...node.args);
    return out;
}

/**
 * Every map/filter/some/every node in an AST, in source order (the validator
 * warns on a body that never reads `it`).
 * @param {ExprNode | null | undefined} node
 * @param {ExprCallNode[]} [out]
 * @returns {ExprCallNode[]}
 */
export function collectEachCalls(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'each') out.push(/** @type {ExprCallNode} */ (node));
    for (const child of childNodes(node)) collectEachCalls(child, out);
    return out;
}

/**
 * True when an AST reads `it` as the item of an enclosing list function.
 * @param {ExprNode | null | undefined} node
 * @returns {boolean}
 */
export function readsItem(node) {
    if (!node || typeof node !== 'object') return false;
    const head = node.kind === 'path' ? node.segments?.[0] : undefined;
    if (head && head.kind === 'local' && head.v !== 'acc') return true;
    // A nested list function's body reads ITS item, not this one.
    if (node.kind === 'each') return readsItem(node.args?.[0]);
    if (node.kind === 'reduce') return readsItem(node.args?.[0]) || readsItem(node.args?.[2]);
    return childNodes(node).some(readsItem);
}

/**
 * Distinct root identifiers referenced by a path (for validation without
 * executing) — e.g. `actions.x.result + form.total` → ['actions','form'].
 * @param {ExprNode | null | undefined} node
 * @param {Set<string>} out
 * @returns {Set<string>}
 */
export function collectRefs(node, out) {
    if (!node || typeof node !== 'object') return out;
    const head = node.kind === 'path' ? node.segments?.[0] : undefined;
    if (head && head.kind === 'name') out.add(String(head.v));
    for (const child of childNodes(node, REF_KEYS)) collectRefs(child, out);
    return out;
}

/**
 * Every host call in an AST, in source order: the nodes a caller has to
 * answer before it evaluates. Walks the same keys as collectRefs.
 * @param {ExprNode | null | undefined} node
 * @param {ExprCallNode[]} [out]
 * @returns {ExprCallNode[]}
 */
export function collectHostCalls(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'hostcall') out.push(/** @type {ExprCallNode} */ (node));
    // `cond` first: a ternary's condition comes before its branches.
    for (const child of childNodes(node)) collectHostCalls(child, out);
    return out;
}

/**
 * Every call of a pure host function (an author's own function) in an AST,
 * in source order: what userFunctions.mjs follows to refuse recursion.
 * @param {ExprNode | null | undefined} node
 * @param {ExprCallNode[]} [out]
 * @returns {ExprCallNode[]}
 */
export function collectUserCalls(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'usercall') out.push(/** @type {ExprCallNode} */ (node));
    for (const child of childNodes(node)) collectUserCalls(child, out);
    return out;
}

/** Node kinds that did not exist before schema version 3 of the app definition. */
const SINCE_3_KINDS = new Set(['list', 'object', 'reduce', 'usercall']);

/**
 * The schema version an expression needs: 3 when it uses anything that was a
 * parse error before version 3 (a list or object literal, `??`, reduce(), an
 * author's function, or a function whose doc entry says `since: 3`), else 0.
 * @param {ExprNode | null | undefined} node
 * @param {ReadonlyMap<string, number>} sinceByName the `since` of every function that has one
 * @returns {number}
 */
export function sinceOf(node, sinceByName) {
    if (!node || typeof node !== 'object') return 0;
    let since = SINCE_3_KINDS.has(node.kind) || (node.kind === 'binop' && /** @type {{ op?: string }} */ (node).op === '??') ? 3 : 0;
    if (node.kind === 'call' && node.name) since = Math.max(since, sinceByName.get(node.name) || 0);
    for (const child of childNodes(node)) since = Math.max(since, sinceOf(child, sinceByName));
    return since;
}
