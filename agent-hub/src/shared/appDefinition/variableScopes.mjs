// @typecheck strict
/**
 * App Studio — what a declared variable may say about its life (schema 3), and the
 * helpers both runtimes read it with. Three optional keys on an entry of
 * definition.variables, each emitted only when set:
 *
 *   scope: 'screen'               the value belongs to the screen the viewer is on: it starts
 *                                 from its default every time a screen is opened, so leaving a
 *                                 screen forgets it. Read as vars.<name>, like any variable.
 *   persist: 'session' | 'local'  the browser keeps the value for the same signed-in viewer of
 *                                 the same app (session: until the tab closes, local: until it
 *                                 is cleared). Never for an anonymous visitor, never in the
 *                                 editor, never on the server. MAX_PERSISTED_VARIABLE_BYTES for
 *                                 all of an app's kept values together.
 *   derived: { expr }             the value is a formula over other variables and the scope
 *                                 (forms, screen, records, currentUser, …), worked out again
 *                                 whenever something it reads changes. A write to it does
 *                                 nothing. While the formula gives nothing the default shows.
 *
 * A derived variable has no scope and is not kept (the canonicalizer drops both); a
 * screen variable is not kept either. Derived variables are worked out in the order they
 * read each other; the members of a cycle (the validator names it) keep their default.
 * Each formula is evaluated once per pass, so a pass is bounded by the number of variables.
 *
 * The server never takes a derived value from the browser: buildServerScope works every
 * derived variable out again over its own scope (actionExecutor/shared.js). The screenshot
 * render, the headless entry and the dry run start from initialVariableValues().
 *
 * Pure. Generated copy for the web in agent-hub/src/shared/appDefinition/ (npm run gen:shared).
 */
import { parseExpr, tryEvaluate } from '../expr/engine.mjs';
import { seedVariableDefaults, VARIABLE_NAME_RE } from './variables.mjs';

/** The values of `scope` other than the base (an app-wide variable has no `scope` key). */
export const VARIABLE_SCOPES = Object.freeze(['screen']);
/** The values of `persist`. */
export const VARIABLE_PERSIST_MODES = Object.freeze(['session', 'local']);
/** What the browser keeps for one viewer of one app, all kept values together (UTF-8 bytes of the JSON). */
export const MAX_PERSISTED_VARIABLE_BYTES = 16384;

/**
 * @typedef {{ name: string, type?: unknown, default?: unknown, scope?: unknown, persist?: unknown, derived?: unknown }} VariableDecl
 * @typedef {{ order: string[], exprs: Map<string, string>, cyclic: Set<string>, cycles: string[][] }} DerivedPlan
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} variables @returns {VariableDecl[]} */
function declsOf(variables) {
    if (!Array.isArray(variables)) return [];
    return /** @type {VariableDecl[]} */ (variables.filter((v) => isObject(v) && typeof v.name === 'string' && VARIABLE_NAME_RE.test(v.name)));
}

/**
 * The formula text of a derived variable, or null.
 * @param {unknown} variable
 * @returns {string | null}
 */
export function derivedExprOf(variable) {
    if (!isObject(variable) || !isObject(variable.derived)) return null;
    const expr = variable.derived.expr;
    return typeof expr === 'string' && expr.trim() ? expr : null;
}

/**
 * The names a formula reads under `vars`: `vars.x` and `vars["x"]`. `dynamic` when it reads
 * `vars` as a whole or by a computed key, so it may read any of them. A text that does not
 * parse reads nothing.
 * @param {string} expr
 * @returns {{ names: Set<string>, dynamic: boolean }}
 */
export function varsReadBy(expr) {
    /** @type {Set<string>} */
    const names = new Set();
    let dynamic = false;
    /** @param {unknown} node @param {number} depth */
    const visit = (node, depth) => {
        if (depth > 200 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
        const n = /** @type {Record<string, unknown>} */ (node);
        const key = varsKeyOf(n);
        if (typeof key === 'string') names.add(key); else if (key === DYNAMIC) dynamic = true;
        for (const value of Object.values(n)) visit(value, depth + 1);
    };
    // A text that does not parse reads nothing.
    try { visit(parseExpr(expr), 0); } catch { return { names: new Set(), dynamic: false }; }
    return { names, dynamic };
}

const DYNAMIC = Symbol('dynamic');

/**
 * For a path node that starts at `vars`: the name it reads, or DYNAMIC (the whole bag, or a
 * computed key). undefined for every other node.
 * @param {Record<string, unknown>} node
 * @returns {string | typeof DYNAMIC | undefined}
 */
function varsKeyOf(node) {
    if (node.kind !== 'path' || !Array.isArray(node.segments)) return undefined;
    const [head, next] = /** @type {Array<Record<string, unknown> | undefined>} */ (node.segments);
    if (!head || head.kind !== 'name' || head.v !== 'vars') return undefined;
    if (next && next.kind === 'name' && typeof next.v === 'string') return next.v;
    const index = next && next.kind === 'index' ? next.expr : undefined;
    if (isObject(index) && index.kind === 'str' && typeof index.v === 'string') return index.v;
    return DYNAMIC;
}

/** @type {WeakMap<object, DerivedPlan>} */
const PLANS = new WeakMap();

/**
 * The derived variables of a declaration list in the order they can be worked out, and the
 * cycles among them (each as the names around it, the first repeated at the end). Remembered
 * per list: a definition keeps its `variables` array across every edit that is not one.
 * @param {unknown} variables
 * @returns {DerivedPlan}
 */
export function derivedPlan(variables) {
    const cached = Array.isArray(variables) ? PLANS.get(variables) : undefined;
    if (cached) return cached;
    /** @type {Map<string, string>} */
    const exprs = new Map();
    for (const v of declsOf(variables)) {
        const expr = derivedExprOf(v);
        if (expr !== null && !exprs.has(v.name)) exprs.set(v.name, expr);
    }
    /** @type {Map<string, string[]>} */
    const deps = new Map();
    for (const [name, expr] of exprs) {
        const read = varsReadBy(expr);
        deps.set(name, read.dynamic ? [...exprs.keys()].filter((other) => other !== name) : [...read.names].filter((dep) => exprs.has(dep)));
    }
    const plan = orderDerived(exprs, deps);
    if (Array.isArray(variables)) PLANS.set(variables, plan);
    return plan;
}

/**
 * Depth-first order over the dependency graph; a name met again while it is still open closes a cycle.
 * @param {Map<string, string>} exprs
 * @param {Map<string, string[]>} deps
 * @returns {DerivedPlan}
 */
function orderDerived(exprs, deps) {
    /** @type {string[]} */
    const order = [];
    /** @type {Set<string>} */
    const cyclic = new Set();
    /** @type {string[][]} */
    const cycles = [];
    /** @type {Map<string, 'open' | 'done'>} */
    const state = new Map();
    /** @type {string[]} */
    const stack = [];
    /** @param {string} name */
    const visit = (name) => {
        const seen = state.get(name);
        if (seen === 'done') return;
        if (seen === 'open') {
            const ring = stack.slice(stack.indexOf(name));
            for (const member of ring) cyclic.add(member);
            cycles.push([...ring, name]);
            return;
        }
        state.set(name, 'open');
        stack.push(name);
        for (const dep of deps.get(name) || []) visit(dep);
        stack.pop();
        state.set(name, 'done');
        order.push(name);
    };
    for (const name of exprs.keys()) visit(name);
    return { order: order.filter((name) => !cyclic.has(name)), exprs, cyclic, cycles };
}

/** True when a declaration list has at least one derived variable. @param {unknown} variables */
export function hasDerivedVariables(variables) {
    return derivedPlan(variables).exprs.size > 0;
}

/**
 * `scope.vars` with every derived variable worked out against `scope`, in dependency order.
 * A formula that gives nothing (or fails) shows the variable's default; a member of a cycle
 * keeps its default. The same `scope.vars` object comes back when nothing is derived.
 * @param {unknown} variables
 * @param {Record<string, unknown> | null | undefined} scope
 * @returns {Record<string, unknown>}
 */
export function applyDerivedVariables(variables, scope) {
    const base = scope && isObject(scope.vars) ? /** @type {Record<string, unknown>} */ (scope.vars) : {};
    const plan = derivedPlan(variables);
    if (!plan.exprs.size) return base;
    const defaults = /** @type {Record<string, unknown>} */ (seedVariableDefaults(variables));
    /** @type {Record<string, unknown>} */
    const vars = { ...base };
    for (const name of plan.cyclic) vars[name] = defaults[name] ?? null;
    for (const name of plan.order) {
        const { value } = tryEvaluate(/** @type {string} */ (plan.exprs.get(name)), { ...scope, vars });
        vars[name] = value === undefined || value === null ? (defaults[name] ?? null) : value;
    }
    return vars;
}

/**
 * The values a run starts from: the declared defaults, then `scope.vars` over them (a
 * screenshot's own values), then the derived variables worked out against that scope. What
 * the screenshot render, the headless entry and the dry run hand the binding planner.
 * @param {unknown} variables
 * @param {Record<string, unknown> | null | undefined} [scope]
 * @returns {Record<string, unknown>}
 */
export function initialVariableValues(variables, scope) {
    const given = scope && isObject(scope.vars) ? scope.vars : {};
    const vars = { .../** @type {Record<string, unknown>} */ (seedVariableDefaults(variables)), ...given };
    return applyDerivedVariables(variables, { ...(scope || {}), vars });
}

/** The names of the screen variables. @param {unknown} variables @returns {string[]} */
export function screenVariableNames(variables) {
    return declsOf(variables).filter((v) => v.scope === 'screen' && derivedExprOf(v) === null).map((v) => v.name);
}

/**
 * `vars` with every screen variable back at its default: what a newly opened screen starts
 * from. The same object when nothing changes.
 * @param {Record<string, unknown>} vars
 * @param {unknown} variables
 * @returns {Record<string, unknown>}
 */
export function resetScreenVariables(vars, variables) {
    const names = screenVariableNames(variables);
    if (!names.length) return vars;
    const defaults = /** @type {Record<string, unknown>} */ (seedVariableDefaults(variables));
    /** @type {Record<string, unknown> | null} */
    let out = null;
    for (const name of names) {
        const value = defaults[name] ?? null;
        if (Object.hasOwn(vars, name) && sameJson(vars[name], value)) continue;
        out = out || { ...vars };
        out[name] = value;
    }
    return out || vars;
}

/** @param {unknown} a @param {unknown} b */
function sameJson(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * The variables the browser keeps, per mode: `{ name, type, persist }`. A derived or screen
 * variable is never kept, whatever the entry says.
 * @param {unknown} variables
 * @returns {Array<{ name: string, type: string, persist: 'session' | 'local' }>}
 */
export function persistedVariables(variables) {
    return declsOf(variables)
        .filter((v) => (v.persist === 'session' || v.persist === 'local') && v.scope !== 'screen' && derivedExprOf(v) === null)
        .map((v) => ({ name: v.name, type: typeof v.type === 'string' ? v.type : 'any', persist: /** @type {'session' | 'local'} */ (v.persist) }));
}
