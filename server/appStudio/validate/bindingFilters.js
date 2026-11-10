// @typecheck
/**
 * App Studio validator: the filter grammar of the record / records / aggregate
 * bindings and of the filter-mode record writes. Clauses, the `any` / `all` /
 * `not` groups (nested to MAX_FILTER_DEPTH) and column comparisons.
 */

'use strict';

const { FORMULA_SCOPE_ROOTS } = require('../componentSpecs');
const { FILTER_OPS } = require('../dataModel');
const { isObject } = require('./shared');
const { countFilterLeaves, MAX_FILTER_CLAUSES: MAX_FILTERS, MAX_FILTER_DEPTH, FIELD_COMPARE_OPS } = require('../../shared/expr/filterGroups.mjs');
const { validateFormula } = require('./formulas');
const { checkFieldRef } = require('./refs');

// ---------------------------------------------------------------------------
// record/records binding filter & sort — the exact query-descriptor grammar
// the compiler accepts. A filter is an ARRAY of { field, op, value? } where
// `value` may be a JSON literal, an array of literals (in/between), or a
// {kind:'formula', expr} resolved CLIENT-SIDE against live scope before the
// fetch (the expr is parse-compiled here, never executed). A legacy string
// filter is treated as one formula expression. Sort is [{ field, dir }].
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 */
function validateFilterValue(v, path, ctx) {
    const { pushE } = ctx;
    if (v === undefined || v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return;
    if (isObject(v)) {
        if (v.kind === 'formula') { validateFormula(v.expr, `${path}.expr`, ctx, FORMULA_SCOPE_ROOTS); return; }
        pushE({ code: 'binding.filter_invalid', severity: 'error', path, message: 'A filter value must be a literal, an array of literals (for in/between), or {kind:"formula", expr}.', hint: 'Wrap dynamic values as {kind:"formula", expr:"vars.…"}.' });
        return;
    }
    if (Array.isArray(v)) {
        v.forEach((item, j) => validateFilterValue(item, `${path}[${j}]`, ctx));
        return;
    }
    pushE({ code: 'binding.filter_invalid', severity: 'error', path, message: 'Unsupported filter value.', hint: 'Use a string/number/boolean/null literal, an array of literals, or {kind:"formula", expr}.' });
}

/**
 * @param {string} path
 * @param {string} label
 */
function validateBindingFilter(filter, path, ctx, tableId, label) {
    const { pushE } = ctx;
    if (typeof filter === 'string') {
        // Legacy formula-expression filter — compiled, never executed.
        validateFormula(filter, path, ctx, FORMULA_SCOPE_ROOTS);
        return;
    }
    if (!Array.isArray(filter)) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path, message: `${label} filter must be an array of { field, op, value? } entries.`, hint: `Ops: ${FILTER_OPS.join(', ')}. value may be a literal or {kind:"formula", expr}.` });
        return;
    }
    filter.forEach((entry, i) => validateFilterEntry(entry, `${path}[${i}]`, { ctx, tableId, label }, 0));
    const leaves = countFilterLeaves(filter);
    if (leaves > MAX_FILTERS) {
        pushE({ code: 'binding.filter_too_many', severity: 'error', path, message: `${label} filter has ${leaves} clauses; the limit is ${MAX_FILTERS}, counting the clauses inside any groups.`, hint: 'Combine values with op "in" instead of one clause per value.' });
    }
}

/**
 * One entry of a filter list or of a group: an `any` / `all` / `not` group
 * (nested to MAX_FILTER_DEPTH) or a clause.
 * @param {unknown} entry
 * @param {string} p
 * @param {FilterScope} scope
 * @param {number} depth groups above this entry
 */
function validateFilterEntry(entry, p, scope, depth) {
    const group = !isObject(entry) ? null
        : entry.any !== undefined ? 'any'
            : entry.field !== undefined ? null
                : entry.all !== undefined ? 'all'
                    : entry.not !== undefined ? 'not' : null;
    if (group === null) { validateFilterClause(entry, p, scope.ctx, scope.tableId, scope.label); return; }
    if (depth >= MAX_FILTER_DEPTH) {
        scope.ctx.pushE({ code: 'binding.filter_too_deep', severity: 'error', path: p, message: `Filter groups nest at most ${MAX_FILTER_DEPTH} deep.`, hint: 'Flatten the innermost group: (a AND (b AND c)) is (a AND b AND c).' });
        return;
    }
    if (group === 'any') validateAnyGroup(entry, p, scope, depth);
    else if (group === 'all') validateAllGroup(entry, p, scope, depth);
    else validateNotGroup(entry, p, scope, depth);
}

/**
 * One `{ all: [entry, …] }` AND group: a non-empty list of clauses and groups.
 * @param {Record<string, unknown>} entry
 * @param {string} p
 * @param {FilterScope} scope
 * @param {number} depth
 */
function validateAllGroup(entry, p, scope, depth) {
    const { pushE } = scope.ctx;
    if (entry.op !== undefined || entry.value !== undefined || entry.not !== undefined) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: p, message: 'A filter entry is either a clause { field, op, value? } or one group ({ any }, { all } or { not }), not both.', hint: 'Give each group its own entry.' });
    }
    if (!Array.isArray(entry.all) || entry.all.length === 0) {
        pushE({ code: 'binding.filter_group_empty', severity: 'error', path: `${p}.all`, message: 'An AND group needs a non-empty all list.', hint: '{ "all": [{ "field": "status", "op": "eq", "value": "open" }, { "field": "priority", "op": "eq", "value": "high" }] }' });
        return;
    }
    checkGroupRequired(entry, p, scope.ctx);
    entry.all.forEach((member, j) => validateFilterEntry(member, `${p}.all[${j}]`, scope, depth + 1));
}

/**
 * One `{ not: entry }` group: exactly one clause or group.
 * @param {Record<string, unknown>} entry
 * @param {string} p
 * @param {FilterScope} scope
 * @param {number} depth
 */
function validateNotGroup(entry, p, scope, depth) {
    const { pushE } = scope.ctx;
    if (entry.op !== undefined || entry.value !== undefined) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: p, message: 'A filter entry is either a clause { field, op, value? } or one group ({ any }, { all } or { not }), not both.', hint: 'Give each group its own entry.' });
    }
    if (!isObject(entry.not)) {
        pushE({ code: 'binding.filter_group_empty', severity: 'error', path: `${p}.not`, message: '`not` takes one clause or one group, not a list.', hint: '{ "not": { "field": "status", "op": "eq", "value": "done" } }, or { "not": { "any": [...] } } for several.' });
        return;
    }
    checkGroupRequired(entry, p, scope.ctx);
    validateFilterEntry(entry.not, `${p}.not`, scope, depth + 1);
}

/** @param {Record<string, unknown>} entry @param {string} p */
function checkGroupRequired(entry, p, ctx) {
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        ctx.pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.required`, message: '`required` must be true or false.', hint: 'Set required:true when the component should show nothing until the group has a value.' });
    }
}

/**
 * One `{ any: [entry, …] }` OR group: a non-empty list of clauses and groups
 * (an OR group directly inside an OR group is refused: it is the same group).
 * @param {Record<string, unknown>} entry
 * @param {string} p
 * @param {FilterScope} scope
 * @param {number} depth
 */
function validateAnyGroup(entry, p, scope, depth) {
    const { pushE } = scope.ctx;
    if (entry.field !== undefined || entry.op !== undefined || entry.value !== undefined) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: p, message: 'A filter entry is either a clause { field, op, value? } or an OR group { any: [...] }, not both.', hint: 'Move the clause into the group\'s any list, or next to the group.' });
    }
    if (!Array.isArray(entry.any) || entry.any.length === 0) {
        pushE({ code: 'binding.filter_group_empty', severity: 'error', path: `${p}.any`, message: 'An OR group needs a non-empty any list of clauses.', hint: '{ "any": [{ "field": "status", "op": "eq", "value": "open" }, { "field": "priority", "op": "eq", "value": "high" }] }' });
        return;
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.required`, message: '`required` must be true or false.', hint: 'Set required:true when the component should show nothing until one of the clauses has a value.' });
    }
    entry.any.forEach((clause, j) => {
        const cp = `${p}.any[${j}]`;
        if (isObject(clause) && clause.any !== undefined) {
            pushE({ code: 'binding.filter_group_nested', severity: 'error', path: cp, message: 'An OR group cannot hold another group.', hint: 'Put its clauses directly in this group\'s any list (a OR (b OR c) is a OR b OR c).' });
            return;
        }
        validateFilterEntry(clause, cp, scope, depth + 1);
    });
}

/**
 * One filter clause { field, op, value?, required? }.
 * @param {string} p
 * @param {string} label
 */
function validateFilterClause(entry, p, ctx, tableId, label) {
    const { pushE } = ctx;
    if (!isObject(entry)) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: p, message: 'Each filter entry must be an object { field, op, value? }.', hint: `Ops: ${FILTER_OPS.join(', ')}.` });
        return;
    }
    if (typeof entry.field !== 'string' || !entry.field) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.field`, message: 'Each filter entry needs a non-empty string `field`.', hint: 'Use a field key from the bound table (system columns id/created_at/updated_at/created_by/org_id also resolve).' });
    } else {
        checkFieldRef(tableId, entry.field, `${p}.field`, ctx, `${label} filter`);
    }
    if (!FILTER_OPS.includes(entry.op)) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.op`, message: `Unknown filter op ${JSON.stringify(entry.op)}.`, hint: `Use one of: ${FILTER_OPS.join(', ')}.` });
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.required`, message: '`required` must be true or false.', hint: 'Set required:true when the component should show nothing until this value exists.' });
    }
    if (entry.otherField !== undefined && entry.otherField !== null) { validateOtherField(entry, p, ctx, tableId, label); return; }
    validateFilterValue(entry.value, `${p}.value`, ctx);
}

/**
 * The `otherField` of a clause: another column of the same row, compared with one of FIELD_COMPARE_OPS, and no value.
 * @param {Record<string, unknown>} entry
 * @param {string} p
 * @param {string} label
 */
function validateOtherField(entry, p, ctx, tableId, label) {
    const { pushE } = ctx;
    if (typeof entry.otherField !== 'string' || !entry.otherField) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.otherField`, message: '`otherField` must be a field key of the same table.', hint: 'e.g. { "field": "spent", "op": "gt", "otherField": "budget" }.' });
    } else {
        checkFieldRef(tableId, entry.otherField, `${p}.otherField`, ctx, `${label} filter`);
    }
    if (FILTER_OPS.includes(entry.op) && !FIELD_COMPARE_OPS.includes(entry.op)) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.op`, message: `A comparison with otherField cannot use op ${JSON.stringify(entry.op)}.`, hint: `Use one of: ${FIELD_COMPARE_OPS.join(', ')}.` });
    }
    if (entry.value !== undefined && entry.value !== null) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: `${p}.value`, message: 'A clause takes a `value` or an `otherField`, not both.', hint: 'Remove one of the two.' });
    }
}

module.exports = { validateBindingFilter };

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */
/** @typedef {{ ctx: any, tableId: unknown, label: string }} FilterScope  what every entry of one filter is checked against */
