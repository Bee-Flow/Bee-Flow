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
    if (node.kind === 'path' && node.segments?.[0]?.kind === 'local') return true;
    // A nested list function's body reads ITS item, not this one.
    if (node.kind === 'each') return readsItem(node.args?.[0]);
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
