// @typecheck
/**
 * App Studio — the binding planner: for ONE data binding in ONE scope, the
 * decision whether to fetch it, and with which resolved filters, aggregate
 * shape and connector params.
 *
 *   { plan: 'fetch', binding }  read this binding (every dynamic part a literal now)
 *   { plan: 'skip' }            a REQUIRED filter has no value: no query, no rows
 *   { plan: 'needsScope' }      a formula reads a scope root this caller cannot fill,
 *                               so its value cannot be known here
 *
 * Three callers decide this, each with its own IO and its own option set. The
 * option sets are NOT unified on purpose: each one is what that caller did
 * before the planner existed, and bindingPlan.test.mjs pins all three.
 *
 *   CLIENT_PLAN   the web runtime (runtime/resolveBinding.ts, AppDataScope): every
 *                 scope root is live, nothing is ever needs-scope.
 *   RENDER_PLAN   the screenshot render (server/services/appStudioRender.js): only
 *                 the roots its screen-level scope fills the same way the mounted
 *                 runtime does. `item`/`index`, a live `form`, action results
 *                 resolve per instance, and `now` drifts by milliseconds between
 *                 the render's key and the runtime's, so a formula reading them
 *                 is needs-scope. A formula that does not compile is needs-scope.
 *   DRY_RUN_PLAN  the dry run (server/appStudio/appDryRunReads.js): the synthetic
 *                 owner/role scope (`now` included), no aggregate shape
 *                 resolution, `required` is not enforced, a LITERAL null stays as
 *                 written (only a formula that resolved to nothing is omitted),
 *                 a legacy whole-filter string is needs-scope and the filter is
 *                 always rewritten as the resolved list (or left out).
 *
 * Filter rules shared by every option set (the loop is filterGroups.mjs):
 *   • isNull / isNotNull entries have no value and pass through untouched;
 *   • an entry whose resolved value counts as unset is OMITTED, '' / 0 / false
 *     are legit values and stay;
 *   • `{ any: [...] }` groups drop their unresolved clauses and are dropped
 *     themselves when none is left.
 *
 * Live filter mode (client, render): only record / records / aggregate bindings
 * with a non-empty filter array are touched; a binding needing no change is
 * returned AS-IS (identity-stable, memo-friendly); a filter left empty by
 * omission is dropped, so its cache key equals the no-filter key.
 *
 * Aggregate shape: `groupBy`, `aggregates`, `sort`, `limit` may be authored as
 * a formula and resolve against the scope before the fetch, so a report the
 * viewer composed in the running app asks its own question. A formula that
 * resolves to undefined/null leaves the field ABSENT. `tableId` stays literal:
 * it anchors the validator's field checks and the server's table-access gate.
 *
 * Pure: reads nothing, writes nothing, never throws. Generated copy for the web
 * in agent-hub/src/shared/appDefinition/ (npm run gen:shared).
 */
import { compile, tryEvaluate } from '../expr/engine.mjs';
import { resolveFilterList, FILTER_SKIP } from '../expr/filterGroups.mjs';

/** @typedef {Record<string, unknown>} Obj */
/**
 * @typedef {{
 *   resolveShape: boolean,
 *   scopeRoots: ReadonlySet<string> | null,
 *   filterMode: 'live' | 'probe',
 * }} BindingPlanOptions
 *   resolveShape: evaluate an aggregate's formula-valued descriptor fields;
 *   scopeRoots: the roots a formula may read (null: every root is live);
 *   filterMode: 'live' (client, render) or 'probe' (the dry run), see the header.
 */
/** @typedef {{ plan: 'fetch', binding: unknown } | { plan: 'skip' } | { plan: 'needsScope' }} BindingPlan */

/** The descriptor fields of an aggregate binding that may be authored as a formula. */
export const AGGREGATE_SHAPE_FIELDS = Object.freeze(['groupBy', 'aggregates', 'sort', 'limit']);

/** @type {BindingPlanOptions} */
export const CLIENT_PLAN = Object.freeze({ resolveShape: true, scopeRoots: null, filterMode: 'live' });

/** @type {BindingPlanOptions} */
export const RENDER_PLAN = Object.freeze({
    resolveShape: true,
    scopeRoots: new Set(['currentUser', 'vars', 'forms', 'screen', 'today']),
    filterMode: 'live',
});

/** @type {BindingPlanOptions} */
export const DRY_RUN_PLAN = Object.freeze({
    resolveShape: false,
    scopeRoots: new Set(['currentUser', 'vars', 'forms', 'screen', 'now', 'today']),
    filterMode: 'probe',
});

const NEEDS_SCOPE = Symbol('needs-scope');
const DATA_KINDS = new Set(['record', 'records', 'aggregate', 'dataset', 'connector']);
const FILTERED_KINDS = new Set(['record', 'records', 'aggregate']);

/** @param {unknown} v @returns {v is Obj} */
function isObject(v) {
    return !!v && typeof v === 'object';
}

/** @param {unknown} v @returns {v is Obj & { kind: 'formula' }} */
function isFormula(v) {
    return isObject(v) && v.kind === 'formula';
}

/** @param {unknown} binding @returns {BindingPlan} */
function fetch(binding) {
    return { plan: 'fetch', binding };
}

/**
 * A formula value against the scope, or NEEDS_SCOPE when it reads a root the
 * option set cannot fill (or does not compile, when roots are checked).
 * @param {Obj} raw a `{ kind: 'formula', expr }` value
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 */
function formulaValue(raw, scope, o) {
    const roots = o.scopeRoots;
    if (roots) {
        /** @type {string[]} */
        let refs;
        try { refs = compile(String(raw.expr || '')).refs; } catch { return NEEDS_SCOPE; }
        if (!refs.every((r) => roots.has(r))) return NEEDS_SCOPE;
    }
    const expr = raw.expr;
    if (typeof expr !== 'string' || !expr.trim()) return undefined;
    return tryEvaluate(expr, scope || {}).value;
}

/**
 * One dynamic value: a formula is evaluated, anything else is itself.
 * @param {unknown} value
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 */
function dynamicValue(value, scope, o) {
    return isFormula(value) ? formulaValue(value, scope, o) : value;
}

/**
 * An aggregate binding's formula-valued descriptor fields resolved. Any other
 * binding, or an option set without shape resolution, passes through as-is.
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
export function planShape(binding, scope, o) {
    if (!o.resolveShape || !isObject(binding) || binding.kind !== 'aggregate') return fetch(binding);
    let changed = false;
    /** @type {Obj} */
    const out = { ...binding };
    for (const field of AGGREGATE_SHAPE_FIELDS) {
        const raw = binding[field];
        if (!isFormula(raw)) continue;
        const value = formulaValue(raw, scope, o);
        if (value === NEEDS_SCOPE) return { plan: 'needsScope' };
        changed = true;
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return fetch(changed ? out : binding);
}

/**
 * @param {unknown} filters
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @param {import('../expr/filterGroups.mjs').ResolveFilterOptions} [listOpts]
 */
function resolveList(filters, scope, o, listOpts) {
    return resolveFilterList(filters, (value) => {
        const v = dynamicValue(value, scope, o);
        return v === NEEDS_SCOPE ? FILTER_SKIP : v;
    }, listOpts);
}

/**
 * Live mode: the client's resolveBindingFilters (the render adds only its roots).
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
function planLiveFilters(binding, scope, o) {
    if (!isObject(binding) || !FILTERED_KINDS.has(/** @type {string} */ (binding.kind))) return fetch(binding);
    if (!Array.isArray(binding.filter) || binding.filter.length === 0) return fetch(binding);
    const res = resolveList(binding.filter, scope, o);
    if (res.status === 'skip') return { plan: 'needsScope' };
    if (res.status !== 'ok') return { plan: 'skip' };
    if (!res.changed) return fetch(binding);
    if (res.filters.length === 0) {
        const { filter: _dropped, ...rest } = binding;
        return fetch(rest);
    }
    return fetch({ ...binding, filter: res.filters });
}

/**
 * Probe mode: the dry run's filter reading (see the header). The binding comes
 * back with `filter` set to the resolved list, or without `filter`.
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
function planProbeFilters(binding, scope, o) {
    /** @type {Obj} */
    const b = isObject(binding) ? binding : {};
    const { filter, ...rest } = b;
    if (typeof filter === 'string') return { plan: 'needsScope' };
    if (!Array.isArray(filter)) return fetch(rest);
    const res = resolveList(filter, scope, o, {
        ignoreRequired: true,
        isUnset: (value, clause) => (value === undefined || value === null) && isFormula(clause.value),
    });
    if (res.status === 'skip') return { plan: 'needsScope' };
    if (res.status !== 'ok') return { plan: 'skip' };
    return fetch({ ...rest, filter: res.filters });
}

/**
 * A binding's filter list resolved under the option set's filter mode.
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
export function planFilters(binding, scope, o) {
    return o.filterMode === 'probe' ? planProbeFilters(binding, scope, o) : planLiveFilters(binding, scope, o);
}

/**
 * A connector binding's `params` resolved: a formula is evaluated, a param that
 * resolves to undefined is OMITTED (null / '' / 0 / false stay). Any other
 * binding, or non-object params, passes through as-is.
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
export function planParams(binding, scope, o) {
    if (!isObject(binding) || binding.kind !== 'connector') return fetch(binding);
    const params = binding.params;
    if (!isObject(params) || Array.isArray(params)) return fetch(binding);
    let changed = false;
    /** @type {Obj} */
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        const value = dynamicValue(v, scope, o);
        if (value === NEEDS_SCOPE) return { plan: 'needsScope' };
        if (value === undefined) { changed = true; continue; }
        if (value !== v) changed = true;
        out[k] = value;
    }
    return fetch(changed ? { ...binding, params: out } : binding);
}

/**
 * The whole decision for one data binding: a connector resolves its params,
 * every other kind its aggregate shape and then its filters. Anything that is
 * not a data binding is skip.
 * @param {unknown} binding
 * @param {unknown} scope
 * @param {BindingPlanOptions} o
 * @returns {BindingPlan}
 */
export function planBinding(binding, scope, o) {
    if (!isObject(binding) || !DATA_KINDS.has(/** @type {string} */ (binding.kind))) return { plan: 'skip' };
    if (binding.kind === 'connector') return planParams(binding, scope, o);
    const shaped = planShape(binding, scope, o);
    return shaped.plan === 'fetch' ? planFilters(shaped.binding, scope, o) : shaped;
}
