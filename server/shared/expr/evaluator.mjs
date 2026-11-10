// @typecheck strict
/**
 * The evaluator of the expression language: a parsed tree (engine.mjs
 * parseExpr) against a scope. Split out of engine.mjs, which keeps the
 * grammar, the parser and the public API; the safety model is described there.
 */

import { FUNCTIONS } from './functions.mjs';
import { jsonCacheFor, stepInto, stepMatch, walkTokens } from './path.mjs';
import { ExprError, MAX_USER_FUNCTIONS, guardSize, guardValue, tickEach } from './limits.mjs';

const hasOwn = (/** @type {unknown} */ o, /** @type {string} */ k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ── Evaluator ──────────────────────────────────────────
/**
 * The evaluation environment: the host table, the item of the innermost
 * map/filter/some/every/reduce (`it`), the result so far of the innermost
 * reduce (`acc`), how many author functions are being answered (`depth`), and
 * the item budget shared by the whole evaluation (limits.mjs tickEach, guardSize).
 * @typedef {{ kind: string, [field: string]: any }} Node a parsed node or path segment
 * @typedef {{ fn?: (...args: unknown[]) => unknown, unanswered?: string, pure?: boolean, params?: string[], body?: Node }} HostEntry
 * @typedef {{ host: Record<string, HostEntry> | null, it: unknown, acc: unknown, depth: number, budget: { used: number, sizes?: WeakMap<object, number> } }} EvalEnv
 */

/** @param {Node[]} segments @param {unknown} runState @param {EvalEnv} env @returns {any} */
function walkPath(segments, runState, env) {
    const head = segments[0];
    // A call result or a parenthesised value read on like a path (`base`),
    // or `it` inside map/filter/some/every (`local`): the walk starts there.
    if (head && head.kind === 'base') return walkFrom(evalNode(head.expr, runState, env), segments, 1, runState, env);
    if (head && head.kind === 'local') return walkFrom(head.v === 'acc' ? env.acc : env.it, segments, 1, runState, env);
    return walkFrom(runState, segments, 0, runState, env);
}

/** @param {any} start @param {Node[]} segments @param {number} from @param {unknown} runState @param {EvalEnv} env @returns {any} */
function walkFrom(start, segments, from, runState, env) {
    let cur = start;
    const cache = jsonCacheFor(runState);
    for (let i = from; i < segments.length; i++) {
        if (cur == null) return undefined;
        const s = segments[i];
        if (s.kind === 'name') {
            // One step, with the binding resolver's exact rules (path.mjs
            // stepInto): own properties only, so a string's own members
            // (`.length`, `[0]`) resolve while prototype members
            // (`.toUpperCase`, `.constructor`) come back undefined; JSON text
            // is read as the object it encodes; `[-1]` is the last element.
            cur = stepInto(cur, s.v, cache);
        } else if (s.kind === 'wildcard') {
            // `[*]`: hand the remainder to the shared walker, so the same path
            // string means the same list in a binding and in an expression
            // (flatten what the rest produced by one level, keep explicit
            // nulls, a trailing [*] is the list itself). A computed index in
            // the remainder reads the run state, not the element, so it is
            // evaluated once up front.
            const rest = segments.slice(i + 1);
            const tokens = [];
            for (const r of rest) {
                if (r.kind === 'name') tokens.push({ type: 'prop', key: r.v });
                else if (r.kind === 'wildcard') tokens.push({ type: 'wild' });
                else if (r.kind === 'match') tokens.push({ type: 'match', key: r.key, value: r.value });
                else tokens.push({ type: 'prop', key: evalNode(r.expr, runState, env) });
            }
            return walkTokens([{ type: 'wild' }, ...tokens], cur);
        } else if (s.kind === 'match') {
            cur = stepMatch(cur, s.key, s.value, cache);
        } else if (s.kind === 'root') {
            // Internal marker kept for callers that seed a walk at a value.
            cur = s.v;
        } else {
            const k = evalNode(s.expr, runState, env);
            if (cur == null) return undefined;
            // Same gate as the dot branch: x["constructor"] stays undefined,
            // `name[0]` on a string works exactly as it does in a ref binding.
            if (typeof k !== 'string' && typeof k !== 'number') return undefined;
            cur = stepInto(cur, k, cache);
        }
    }
    return cur;
}

/**
 * One node against the scope `ctx`. The node kinds are the keys of EVALUATORS
 * below; anything else is not a tree the parser wrote.
 * @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any}
 */
function evalNode(n, ctx, env) {
    const run = EVALUATORS[n.kind];
    if (!run) throw new ExprError(`Unknown node kind: ${n.kind}`);
    return run(n, ctx, env);
}

/** The arguments of a call, left to right. @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any[]} */
function evalArgs(n, ctx, env) {
    return n.args.map((/** @type {Node} */ a) => evalNode(a, ctx, env));
}

/** A whitelisted function. @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalCall(n, ctx, env) {
    const fn = /** @type {Record<string, (...args: any[]) => unknown>} */ (FUNCTIONS)[n.name];
    if (!fn) throw new ExprError(`Unknown function: ${n.name}`);
    // Every produced text passes the cap (limits.mjs).
    return guardValue(fn(...evalArgs(n, ctx, env)));
}

/** A host function the caller answers. @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalHostCall(n, ctx, env) {
    const h = env.host && hasOwn(env.host, n.name) ? env.host[n.name] : null;
    if (!h || typeof h.fn !== 'function') {
        throw new ExprError(h?.unanswered || `${n.name}() has no answer here`);
    }
    return guardValue(h.fn(...evalArgs(n, ctx, env)));
}

/** @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalUnop(n, ctx, env) {
    const v = evalNode(n.a, ctx, env);
    if (n.op === '!') return !v;
    if (n.op === '-') return -v;
    if (n.op === '+') return +v;
    return undefined;
}

/**
 * The operators that work on both sides as values (`&&`, `||` and `??` decide
 * first whether the right side is evaluated at all: evalBinop).
 * @type {Record<string, (a: any, b: any) => unknown>}
 */
const BINARY_OPS = {
    '+': (a, b) => guardValue(a + b), // a text `+` grows like concat(): same cap
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    '/': (a, b) => a / b,
    '%': (a, b) => a % b,
    // `^` IS pow() — one implementation, so the operator inherits
    // its totality (2 ^ 10000 → null, not Infinity) and can never
    // drift from the function form the builder also emits.
    '^': (a, b) => FUNCTIONS.pow(a, b),
    '==': (a, b) => a == b,
    '!=': (a, b) => a != b,
    '===': (a, b) => a === b,
    '!==': (a, b) => a !== b,
    '<': (a, b) => a < b,
    '<=': (a, b) => a <= b,
    '>': (a, b) => a > b,
    '>=': (a, b) => a >= b,
};

/** @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalBinop(n, ctx, env) {
    if (n.op === '&&') return evalNode(n.a, ctx, env) && evalNode(n.b, ctx, env);
    if (n.op === '||') return evalNode(n.a, ctx, env) || evalNode(n.b, ctx, env);
    if (n.op === '??') { const left = evalNode(n.a, ctx, env); return left == null ? evalNode(n.b, ctx, env) : left; }
    const a = evalNode(n.a, ctx, env);
    const b = evalNode(n.b, ctx, env);
    const op = hasOwn(BINARY_OPS, n.op) ? BINARY_OPS[n.op] : undefined;
    if (!op) throw new ExprError(`Unknown operator: ${n.op}`);
    return op(a, b);
}

/**
 * map/filter/some/every: the body once per item, with the item as `it`.
 * Not a list gives [] (map, filter) or false (some, every); every() of an
 * empty list is false, like everyOf().
 */
/** @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalEach(n, ctx, env) {
    const list = evalNode(n.args[0], ctx, env);
    const body = n.args[1];
    const many = n.name === 'map' || n.name === 'filter';
    if (!Array.isArray(list)) return many ? [] : false;
    const out = [];
    for (const item of list) {
        tickEach(env.budget);
        const v = evalNode(body, ctx, { ...env, it: item });
        if (n.name === 'map') out.push(v);
        else if (n.name === 'filter') { if (v) out.push(item); }
        else if (n.name === 'some') { if (v) return true; }
        else if (!v) return false;
    }
    if (many) return out;
    return n.name === 'every' && list.length > 0;
}

/**
 * reduce(list, expr, start): expr once per item with the item as `it` and the
 * result so far as `acc`; the last result. Not a list gives start. Every
 * result is measured, so a body that doubles `acc` stops at the size cap.
 */
/** @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalReduce(n, ctx, env) {
    const list = evalNode(n.args[0], ctx, env);
    let acc = evalNode(n.args[2], ctx, env);
    if (!Array.isArray(list)) return acc;
    for (const item of list) {
        tickEach(env.budget);
        acc = guardSize(evalNode(n.args[1], ctx, { ...env, it: item, acc }), env.budget);
    }
    return acc;
}

/**
 * A pure host function: `fn(...values)`, or a parsed body evaluated with only
 * its parameters in scope. Each call counts against the item budget and its
 * result is measured, so functions that call each other cannot multiply work
 * or size without bound; `depth` stops a table that was not checked for recursion.
 */
/** @param {Node} n @param {unknown} ctx @param {EvalEnv} env @returns {any} */
function evalUserCall(n, ctx, env) {
    const h = env.host && hasOwn(env.host, n.name) ? env.host[n.name] : null;
    const body = h?.body;
    if (!h || h.pure !== true || (typeof h.fn !== 'function' && !body)) {
        throw new ExprError(h?.unanswered || `${n.name}() has no answer here`);
    }
    if (env.depth >= MAX_USER_FUNCTIONS) throw new ExprError(`${n.name}(): functions call each other more than ${MAX_USER_FUNCTIONS} deep`);
    tickEach(env.budget);
    const values = evalArgs(n, ctx, env);
    if (typeof h.fn === 'function') return guardSize(guardValue(h.fn(...values)), env.budget);
    const params = Array.isArray(h.params) ? h.params : [];
    const scope = Object.fromEntries(params.map((p, i) => [p, values[i]]));
    return guardSize(evalNode(/** @type {Node} */ (body), scope, { host: env.host, it: undefined, acc: undefined, depth: env.depth + 1, budget: env.budget }), env.budget);
}

/** A fresh environment for one evaluation. @param {EvalEnv['host'] | undefined} host @returns {EvalEnv} */
function newEnv(host) {
    return { host: host || null, it: undefined, acc: undefined, depth: 0, budget: { used: 0 } };
}

/**
 * How each node kind is evaluated. No prototype, so a kind is one of these or nothing.
 * @type {Record<string, (n: Node, ctx: unknown, env: EvalEnv) => any>}
 */
const EVALUATORS = Object.assign(Object.create(null), {
    num: (/** @type {Node} */ n) => n.v,
    str: (/** @type {Node} */ n) => n.v,
    bool: (/** @type {Node} */ n) => n.v,
    null: () => null,
    path: (/** @type {Node} */ n, /** @type {unknown} */ ctx, /** @type {EvalEnv} */ env) => walkPath(n.segments, ctx, env),
    each: evalEach,
    reduce: evalReduce,
    list: (/** @type {Node} */ n, /** @type {unknown} */ ctx, /** @type {EvalEnv} */ env) => guardSize(evalArgs(n, ctx, env), env.budget),
    // fromEntries defines own properties, so a "__proto__" key stays a key.
    object: (/** @type {Node} */ n, /** @type {unknown} */ ctx, /** @type {EvalEnv} */ env) => guardSize(Object.fromEntries(n.keys.map((/** @type {string} */ k, /** @type {number} */ i) => [k, evalNode(n.args[i], ctx, env)])), env.budget),
    usercall: evalUserCall,
    call: evalCall,
    hostcall: evalHostCall,
    unop: evalUnop,
    binop: evalBinop,
    ternary: (/** @type {Node} */ n, /** @type {unknown} */ ctx, /** @type {EvalEnv} */ env) => (evalNode(n.cond, ctx, env) ? evalNode(n.a, ctx, env) : evalNode(n.b, ctx, env)),
});

export { evalNode, newEnv };
