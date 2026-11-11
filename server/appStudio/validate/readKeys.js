// @typecheck strict
/**
 * App Studio validator — the marked keys of a data read that need more than their shape:
 * `match` (how the filters join) and `search` (a free search over some columns) of a record,
 * records or aggregate binding (componentSpecs/keys/binding/). The canonicalizer keeps them with
 * the marks' own `clean`; whether the value is usable and the fields exist is said here. A search
 * is the query compiler's records-only group.
 */

'use strict';

const { FORMULA_SCOPE_ROOTS } = require('../componentSpecs');
const { MAX_FILTER_CLAUSES: MAX_FILTERS } = require('../../shared/expr/filterGroups.mjs');
const { isObject } = require('./shared');
const { validateFormula } = require('./formulas');
const { checkFieldRef } = require('./refs');

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */

const MATCH_VALUES = Object.freeze(['all', 'any']);

/**
 * @param {Record<string, unknown>} search
 * @param {string} sp  the path of the search
 * @param {ValidationCtx} ctx
 */
function validateSearchValue(search, sp, ctx) {
    const value = search.value;
    if (isObject(value) && /** @type {Record<string, unknown>} */ (value).kind === 'formula') {
        validateFormula(/** @type {Record<string, unknown>} */ (value).expr, `${sp}.value.expr`, ctx, FORMULA_SCOPE_ROOTS);
    } else if (typeof value !== 'string' || !value) {
        ctx.pushE({ code: 'binding.search_invalid', severity: 'error', path: `${sp}.value`, message: 'The search value must be text or a formula.', hint: 'Use a non-empty string, or {kind:"formula", expr} (a search box).' });
    }
}

/**
 * @param {Record<string, unknown>} search
 * @param {unknown} tableId
 * @param {string} sp  the path of the search
 * @param {ValidationCtx} ctx
 * @param {string} label
 */
function validateSearchFields(search, tableId, sp, ctx, label) {
    const fields = search.fields;
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FILTERS) {
        ctx.pushE({ code: 'binding.search_invalid', severity: 'error', path: `${sp}.fields`, message: `The search needs 1 to ${MAX_FILTERS} field keys to look in.`, hint: 'List the text columns to search, e.g. ["name", "email"].' });
        return;
    }
    fields.forEach((f, i) => {
        if (typeof f !== 'string' || !f) ctx.pushE({ code: 'binding.search_invalid', severity: 'error', path: `${sp}.fields[${i}]`, message: 'Each search field is a field key.', hint: 'Use a field key from the bound table.' });
        else checkFieldRef(tableId, f, `${sp}.fields[${i}]`, ctx, `${label} search`);
    });
}

/**
 * @param {Record<string, unknown>} value  the binding
 * @param {string} path
 * @param {ValidationCtx} ctx
 * @param {string} label
 */
function validateReadKeys(value, path, ctx, label) {
    const { pushE } = ctx;
    if (value.match !== undefined && value.match !== null && !MATCH_VALUES.includes(/** @type {string} */ (value.match))) {
        pushE({ code: 'binding.match_invalid', severity: 'error', path: `${path}.match`, message: `${label} match must be "all" or "any".`, hint: '"any" shows a row when ONE of the top-level filters matches; "all" (the default) needs every one.' });
    }
    if (value.search === undefined || value.search === null) return;
    const sp = `${path}.search`;
    if (value.kind === 'aggregate') {
        pushE({ code: 'binding.search_invalid', severity: 'error', path: sp, message: 'An aggregate has no search.', hint: 'Narrow the rows with `filter`; a search belongs on a records binding.' });
        return;
    }
    if (!isObject(value.search)) {
        pushE({ code: 'binding.search_invalid', severity: 'error', path: sp, message: `${label} search must be { value, fields }.`, hint: '{ "value": { "kind": "formula", "expr": "vars.filters.q" }, "fields": ["name", "email"] }' });
        return;
    }
    const search = /** @type {Record<string, unknown>} */ (value.search);
    validateSearchValue(search, sp, ctx);
    validateSearchFields(search, value.tableId, sp, ctx, label);
}

module.exports = { validateReadKeys };
