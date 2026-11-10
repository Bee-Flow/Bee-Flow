// @typecheck strict
/**
 * Groups in a filter list, and the one loop that resolves a list's dynamic
 * values. A filter list is `[entry, …]` whose top-level entries AND each other.
 * An entry is a clause `{ field, op, value? }` (or `{ field, op, otherField }`,
 * a comparison against another column of the same row), or a group:
 * `{ any: [entry, …] }` (its entries OR each other), `{ all: [entry, …] }`
 * (they AND each other) or `{ not: entry }`. Groups nest to MAX_FILTER_DEPTH.
 * The access predicate always ANDs outside it all
 * (queryCompilerBase.buildWhere), so no group can widen what a viewer may see.
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
 * clause BLOCKS; inside an `any` group an unresolved clause is dropped
 * (narrows) and an emptied group BLOCKS; inside an `all` group, a `not`, or
 * anything under a `not`, an unresolved clause BLOCKS (dropping it there would
 * widen), so a write never widens to every row.
 */

/** Clauses one filter list may hold, top-level and inside groups together (the query compiler's MAX_FILTERS). */
export const MAX_FILTER_CLAUSES = 50;

/** Group levels below the top-level list: `{ any: [{ all: [{ not: clause }] }] }` is the deepest shape. */
export const MAX_FILTER_DEPTH = 3;

/** The ops of a `{ field, op, otherField }` clause: a comparison of two columns of one row. */
export const FIELD_COMPARE_OPS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

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
 * True for an `{ all: [...] }` AND group. An entry that also names a `field`
 * is a clause, as it always was.
 * @param {unknown} entry
 * @returns {entry is Obj & { all: unknown[] }}
 */
export function isAllGroup(entry) {
    return isPlainObject(entry) && Array.isArray(entry.all) && entry.field === undefined && !Array.isArray(entry.any);
}

/**
 * True for a `{ not: entry }` group. An entry that also names a `field` is a
 * clause, as it always was.
 * @param {unknown} entry
 * @returns {entry is Obj & { not: unknown }}
 */
export function isNotGroup(entry) {
    return isPlainObject(entry) && isPlainObject(entry.not) && entry.field === undefined
        && !Array.isArray(entry.any) && !Array.isArray(entry.all);
}

/**
 * True for any group entry (`any`, `all` or `not`).
 * @param {unknown} entry
 */
export function isFilterGroup(entry) {
    return isAnyGroup(entry) || isAllGroup(entry) || isNotGroup(entry);
}

/**
 * True for a `{ field, op, otherField }` clause.
 * @param {unknown} entry
 * @returns {entry is Obj & { otherField: unknown }}
 */
export function isFieldCompare(entry) {
    return isPlainObject(entry) && entry.otherField !== undefined && entry.otherField !== null;
}

/**
 * The members of a group with the path suffix of each; null for a clause.
 * @param {unknown} entry
 * @returns {Array<{ node: unknown, suffix: string }> | null}
 */
export function filterGroupMembers(entry) {
    if (isAnyGroup(entry)) return entry.any.map((node, j) => ({ node, suffix: `.any[${j}]` }));
    if (isAllGroup(entry)) return entry.all.map((node, j) => ({ node, suffix: `.all[${j}]` }));
    if (isNotGroup(entry)) return [{ node: entry.not, suffix: '.not' }];
    return null;
}

/**
 * @param {unknown} entry
 * @param {string} suffix
 * @param {number} depth groups above this entry
 * @param {(clause: unknown, suffix: string) => void} visit
 */
function visitEntry(entry, suffix, depth, visit) {
    // Below the depth limit a group is not opened: it is visited as the
    // malformed clause every checker and the compiler refuse.
    const members = depth < MAX_FILTER_DEPTH ? filterGroupMembers(entry) : null;
    if (!members) { visit(entry, suffix); return; }
    for (const m of members) visitEntry(m.node, suffix + m.suffix, depth + 1, visit);
}

/**
 * Every clause of a filter list, top-level and inside groups at any depth,
 * with its path suffix (`[i]`, `[i].any[j]`, `[i].any[j].all[k]`, `[i].not`).
 * A group itself is not visited.
 * @param {unknown} filters
 * @param {(clause: unknown, suffix: string) => void} visit
 */
export function forEachFilterClause(filters, visit) {
    if (!Array.isArray(filters)) return;
    filters.forEach((entry, i) => visitEntry(entry, `[${i}]`, 0, visit));
}

/**
 * How deep the groups of a filter list nest: 0 for a flat list, 1 for a list
 * with groups of clauses. Counting stops one past MAX_FILTER_DEPTH.
 * @param {unknown} filters
 */
export function filterDepth(filters) {
    /** @param {unknown} entry @param {number} depth @returns {number} */
    const depthOf = (entry, depth) => {
        const members = filterGroupMembers(entry);
        if (!members) return depth;
        if (depth >= MAX_FILTER_DEPTH) return depth + 1;
        let max = depth + 1;
        for (const m of members) max = Math.max(max, depthOf(m.node, depth + 1));
        return max;
    };
    let max = 0;
    for (const entry of Array.isArray(filters) ? filters : []) max = Math.max(max, depthOf(entry, 0));
    return max;
}

/**
 * Every column a filter list reads, group members included: the field of each
 * clause and the other field of a column comparison. What a caller checks
 * against the columns it may read.
 * @param {unknown} filters
 * @returns {string[]}
 */
export function filterClauseFields(filters) {
    /** @type {string[]} */
    const out = [];
    forEachFilterClause(filters, (c) => {
        if (!isPlainObject(c)) return;
        if (typeof c.field === 'string') out.push(c.field);
        if (typeof c.otherField === 'string') out.push(c.otherField);
    });
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
    // A comparison of two columns carries no value to resolve.
    if (isFieldCompare(entry)) return { keep: entry, changed: false };
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
 * @typedef {{ keep: unknown, changed: boolean } | { drop: true, required: boolean, field: string | null } | { skip: true } | FilterListResult} NodeResult
 */

/**
 * What a dropped member means for its group: the result that ends the whole
 * list, or null when the group goes on without it.
 * @param {{ required: boolean, field: string | null }} dropped
 * @param {Required<ResolveFilterOptions>} o
 * @param {boolean} dropBlocks
 * @returns {FilterListResult | null}
 */
function droppedMember(dropped, o, dropBlocks) {
    if (dropped.required && !o.strict) return { status: 'required' };
    if (dropBlocks) return { status: 'blocked', field: dropped.field };
    return null;
}

/**
 * A group left without members: blocked (strict), no query (required), or dropped.
 * @param {Obj} group
 * @param {Required<ResolveFilterOptions>} o
 * @param {string | null} firstField
 * @returns {NodeResult}
 */
function emptiedGroup(group, o, firstField) {
    if (o.strict) return { status: 'blocked', field: firstField };
    if (group.required && !o.ignoreRequired) return { status: 'required' };
    return { drop: true, required: false, field: null };
}

/**
 * An `any` or `all` group resolved: members dropped when unresolved (a
 * required member still means no query), the group dropped when left empty
 * unless it is required (read) or always (strict: blocked). In strict
 * semantics a dropped member only narrows inside an `any` group that is not
 * under a `not`; everywhere else it blocks.
 * @param {Obj} group
 * @param {'any' | 'all'} key
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue
 * @param {Required<ResolveFilterOptions>} o
 * @param {{ depth: number, underNot: boolean }} at
 * @returns {NodeResult}
 */
function resolveGroup(group, key, resolveValue, o, at) {
    const members = [];
    let changed = false;
    let firstField = null;
    const dropBlocks = o.strict && (key === 'all' || at.underNot);
    for (const m of /** @type {unknown[]} */ (group[key])) {
        const r = resolveNode(m, resolveValue, o, { depth: at.depth + 1, underNot: at.underNot });
        if ('status' in r || 'skip' in r) return r;
        if ('drop' in r) {
            if (firstField === null) firstField = r.field;
            const end = droppedMember(r, o, dropBlocks);
            if (end) return end;
            changed = true;
            continue;
        }
        if (r.changed) changed = true;
        members.push(r.keep);
    }
    if (members.length === 0) return emptiedGroup(group, o, firstField);
    if (!changed) return { keep: group, changed: false };
    const { required: _required, ...rest } = group;
    return { keep: { ...rest, [key]: members }, changed: true };
}

/**
 * A `not` group resolved: it goes when what it negates goes (strict: blocked).
 * @param {Obj & { not: unknown }} group
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue
 * @param {Required<ResolveFilterOptions>} o
 * @param {{ depth: number, underNot: boolean }} at
 * @returns {NodeResult}
 */
function resolveNot(group, resolveValue, o, at) {
    const r = resolveNode(group.not, resolveValue, o, { depth: at.depth + 1, underNot: true });
    if ('status' in r || 'skip' in r) return r;
    if ('drop' in r) {
        if (o.strict) return { status: 'blocked', field: r.field };
        if ((r.required || group.required) && !o.ignoreRequired) return { status: 'required' };
        return { drop: true, required: false, field: null };
    }
    if (!r.changed) return { keep: group, changed: false };
    const { required: _required, ...rest } = group;
    return { keep: { ...rest, not: r.keep }, changed: true };
}

/**
 * One entry inside a group: a nested group, or a clause (whose `required` is
 * the author's flag only; the group decides what a drop means).
 * @param {unknown} entry
 * @param {(value: unknown, clause: Obj) => unknown} resolveValue
 * @param {Required<ResolveFilterOptions>} o
 * @param {{ depth: number, underNot: boolean }} at depth: groups above this entry
 * @returns {NodeResult}
 */
function resolveNode(entry, resolveValue, o, at) {
    if (at.depth < MAX_FILTER_DEPTH) {
        if (isAnyGroup(entry)) return resolveGroup(entry, 'any', resolveValue, o, at);
        if (isAllGroup(entry)) return resolveGroup(entry, 'all', resolveValue, o, at);
        if (isNotGroup(entry)) return resolveNot(entry, resolveValue, o, at);
    }
    // A group below the depth limit is left as it is, for the compiler to refuse:
    // resolving it as a clause would drop it and quietly widen the query.
    else if (isFilterGroup(entry)) return { keep: entry, changed: false };
    return resolveClause(entry, resolveValue, at.depth > 0 ? { ...o, strict: false } : o);
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
        const r = resolveNode(entry, resolveValue, o, { depth: 0, underNot: false });
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
