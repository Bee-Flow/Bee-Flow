// @typecheck strict
/**
 * OR groups in a filter list, and the one loop that resolves a list's dynamic
 * values. A filter list is `[clause | { any: [clause, …], required?: true }]`:
 * the top-level entries AND each other, the clauses of one `any` group OR
 * each other, one level deep. The access predicate always ANDs outside it all
 * (queryCompilerBase.buildWhere).
 *
 * Every place that turns an authored filter list into literals (the web and
 * phone runtime, the server render, the server step reads, the dry run)
 * resolves through resolveFilterList with its own options, so a group means
 * the same in all of them.
 *
 * Read semantics (default): an unresolved clause is dropped (an empty
 * filter_bar field filters nothing), an unresolved `required` clause or an
 * emptied `required` group means no query at all, a group left empty is
 * dropped. Strict semantics (`strict: true`, writes): any unresolved top-level
 * clause BLOCKS; inside a group an unresolved clause is dropped (narrows) and
 * an emptied group BLOCKS, so a write never widens to every row.
 */

/** Clauses one filter list may hold, top-level and inside groups together (the query compiler's MAX_FILTERS). */
export const MAX_FILTER_CLAUSES = 50;

/** Ops without a value: they never resolve and never drop. */
export const NO_VALUE_FILTER_OPS = new Set(['isNull', 'isNotNull']);

/** What a resolveValue answers when the value cannot be known here: the caller skips the whole list. */
export const FILTER_SKIP = Symbol('filter-skip');

/** @typedef {Record<string, unknown>} Obj */

/** @param {unknown} v @returns {v is Obj} */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * True for an `{ any: [...] }` OR group.
 * @param {unknown} entry
 * @returns {entry is Obj & { any: unknown[] }}
 */
export function isAnyGroup(entry) {
    return isPlainObject(entry) && Array.isArray(entry.any);
}

/**
 * Every clause of a filter list, top-level and inside groups, with its path
 * suffix (`[i]` or `[i].any[j]`). A group itself is not visited.
 * @param {unknown} filters
 * @param {(clause: unknown, suffix: string) => void} visit
 */
export function forEachFilterClause(filters, visit) {
    if (!Array.isArray(filters)) return;
    filters.forEach((entry, i) => {
        if (isAnyGroup(entry)) entry.any.forEach((c, j) => visit(c, `[${i}].any[${j}]`));
        else visit(entry, `[${i}]`);
    });
}

/**
 * The field of every clause that names one, group members included: what a
 * caller checks against the columns it may read.
 * @param {unknown} filters
 * @returns {string[]}
 */
export function filterClauseFields(filters) {
    /** @type {string[]} */
    const out = [];
    forEachFilterClause(filters, (c) => { if (isPlainObject(c) && typeof c.field === 'string') out.push(c.field); });
    return out;
}

/**
 * The number of clauses (top-level plus group members): what MAX_FILTERS caps.
 * @param {unknown} filters
 */
export function countFilterLeaves(filters) {
    let n = 0;
    forEachFilterClause(filters, () => { n += 1; });
    return n;
}

/**
 * @typedef {{
 *   isUnset?: (v: unknown, clause: Obj) => boolean,
 *   keepMalformed?: boolean,
 *   noValueOps?: boolean,
 *   ignoreRequired?: boolean,
 *   strict?: boolean,
 * }} ResolveFilterOptions
 *   isUnset: when a resolved value counts as missing (default null/undefined);
 *   ignoreRequired: `required` is not looked at, an unresolved clause is just dropped (the dry run);
 *   keepMalformed: a non-object entry passes through untouched (default true) or is dropped;
 *   noValueOps: isNull/isNotNull pass through untouched (default true);
 *   strict: write semantics (see the header).
 */

/**
 * @typedef {{ status: 'ok', filters: unknown[], changed: boolean }
 *   | { status: 'required' }
 *   | { status: 'skip' }
 *   | { status: 'blocked', field: string | null }} FilterListResult
 */

/**
 * One clause resolved: kept (itself or rewritten), dropped, or skip.
 * @param {unknown} entry
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue
 * @param {Required<ResolveFilterOptions>} o
 * @returns {{ keep: unknown, changed: boolean } | { drop: true, required: boolean, field: string | null } | { skip: true }}
 */
function resolveClause(entry, resolveValue, o) {
    if (!isPlainObject(entry)) return o.keepMalformed ? { keep: entry, changed: false } : { drop: true, required: false, field: null };
    if (o.noValueOps && NO_VALUE_FILTER_OPS.has(/** @type {string} */ (entry.op))) return { keep: entry, changed: false };
    const { required, ...rest } = entry;
    const value = resolveValue(entry.value, entry);
    if (value === FILTER_SKIP) return { skip: true };
    if (o.isUnset(value, entry)) {
        return { drop: true, required: (Boolean(required) && !o.ignoreRequired) || o.strict, field: typeof entry.field === 'string' ? entry.field : null };
    }
    if (required !== undefined) return { keep: { ...rest, value }, changed: true };
    if (value === entry.value) return { keep: entry, changed: false };
    return { keep: { ...rest, value }, changed: true };
}

/**
 * An `any` group resolved: members dropped when unresolved (a required member
 * still means no query), the group dropped when left empty unless it is
 * required (read) or always (strict: blocked).
 * @param {Obj & { any: unknown[] }} group
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue
 * @param {Required<ResolveFilterOptions>} o
 * @returns {{ keep: unknown, changed: boolean } | { drop: true, required: boolean, field: string | null } | FilterListResult}
 */
function resolveGroup(group, resolveValue, o) {
    const members = [];
    let changed = false;
    let firstField = null;
    for (const m of group.any) {
        const r = resolveClause(m, resolveValue, { ...o, strict: false });
        if ('skip' in r) return { status: 'skip' };
        if ('drop' in r) {
            if (firstField === null) firstField = r.field;
            if (r.required && !o.strict) return { status: 'required' };
            changed = true;
            continue;
        }
        if (r.changed) changed = true;
        members.push(r.keep);
    }
    if (members.length === 0) {
        if (o.strict) return { status: 'blocked', field: firstField };
        if (group.required && !o.ignoreRequired) return { status: 'required' };
        return { drop: true, required: false, field: null };
    }
    if (!changed) return { keep: group, changed: false };
    const { required: _required, ...rest } = group;
    return { keep: { ...rest, any: members }, changed: true };
}

/**
 * Resolve a filter list's dynamic values. Unchanged lists and entries keep
 * their identity (`changed: false`), which the web and phone cache keys use.
 * @param {unknown} filters
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue the clause's value resolved, or FILTER_SKIP
 * @param {ResolveFilterOptions} [opts]
 * @returns {FilterListResult}
 */
export function resolveFilterList(filters, resolveValue, opts = {}) {
    /** @type {Required<ResolveFilterOptions>} */
    const o = {
        isUnset: opts.isUnset || ((v) => v === undefined || v === null),
        keepMalformed: opts.keepMalformed !== false,
        noValueOps: opts.noValueOps !== false,
        ignoreRequired: opts.ignoreRequired === true,
        strict: opts.strict === true,
    };
    if (!Array.isArray(filters)) return { status: 'ok', filters: [], changed: false };
    const out = [];
    let changed = false;
    for (const entry of filters) {
        const r = isAnyGroup(entry) ? resolveGroup(entry, resolveValue, o) : resolveClause(entry, resolveValue, o);
        if ('status' in r) return r;
        if ('skip' in r) return { status: 'skip' };
        if ('drop' in r) {
            if (r.required) return o.strict ? { status: 'blocked', field: r.field } : { status: 'required' };
            changed = true;
            continue;
        }
        if (r.changed) changed = true;
        out.push(r.keep);
    }
    return { status: 'ok', filters: out, changed };
}
