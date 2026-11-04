// @typecheck
'use strict';

/**
 * `{ any: [...] }` OR groups in a record/records/aggregate binding filter:
 * what the validator accepts and refuses, the each_without_it formula warning,
 * and the canonicalizer's `or` → `any` and nested-group repairs.
 *
 * Run: node --test appStudio/validate/bindings.anyGroup.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateBinding } = require('./bindings');
const { validateFormula } = require('./formulas');
const { canonicalFilterList } = require('../canonicalize/bindings');

function findings(binding) {
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const warnings = [];
    const ctx = {
        pushE: (/** @type {any} */ r) => errors.push(r), pushW: (/** @type {any} */ r) => warnings.push(r),
        actionIds: new Set(),
        dataTables: new Map([['tbl_t', new Set(['status', 'priority'])]]),
    };
    validateBinding('source', binding, 'screens[0].x.props.source', ctx);
    return { errors, warnings };
}
const codes = (/** @type {any[]} */ list) => list.map((e) => `${e.code}@${e.path}`);
const records = (/** @type {unknown} */ filter) => findings({ kind: 'records', tableId: 'tbl_t', filter });
const OPEN = { field: 'status', op: 'eq', value: 'open' };
const HIGH = { field: 'priority', op: 'eq', value: { kind: 'formula', expr: 'vars.p' } };

test('an any group with valid clauses validates clean, on records, record and aggregate', () => {
    assert.deepStrictEqual(records([{ any: [OPEN, HIGH] }]).errors, []);
    assert.deepStrictEqual(records([OPEN, { any: [OPEN, HIGH], required: true }]).errors, []);
    assert.deepStrictEqual(findings({ kind: 'record', tableId: 'tbl_t', filter: [{ any: [OPEN] }] }).errors, []);
    assert.deepStrictEqual(findings({ kind: 'aggregate', tableId: 'tbl_t', filter: [{ any: [OPEN, HIGH] }], aggregates: [{ fn: 'count', as: 'n' }] }).errors, []);
});

test('the clauses inside a group are checked like top-level ones, at their own path', () => {
    const { errors } = records([{ any: [OPEN, { field: 'nope', op: 'eq', value: 1 }, { field: 'status', op: 'zap' }] }]);
    const p = 'screens[0].x.props.source.filter[0].any';
    assert.deepStrictEqual(codes(errors), [`binding.unknown_field@${p}[1].field`, `binding.filter_invalid@${p}[2].op`]);
});

test('a formula inside a group is compiled', () => {
    const { errors } = records([{ any: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: '1 +' } }] }]);
    assert.deepStrictEqual(codes(errors), ['formula.parse_error@screens[0].x.props.source.filter[0].any[0].value.expr']);
});

test('an empty group, a nested group, field next to any and a bad required are refused', () => {
    const p = 'screens[0].x.props.source.filter[0]';
    assert.deepStrictEqual(codes(records([{ any: [] }]).errors), [`binding.filter_group_empty@${p}.any`]);
    assert.deepStrictEqual(codes(records([{ any: 'x' }]).errors), [`binding.filter_group_empty@${p}.any`]);
    assert.deepStrictEqual(codes(records([{ any: [OPEN, { any: [HIGH] }] }]).errors), [`binding.filter_group_nested@${p}.any[1]`]);
    assert.deepStrictEqual(codes(records([{ field: 'status', any: [OPEN] }]).errors), [`binding.filter_invalid@${p}`]);
    assert.deepStrictEqual(codes(records([{ any: [OPEN], required: 'yes' }]).errors), [`binding.filter_invalid@${p}.required`]);
});

test('the clause cap counts the clauses inside groups', () => {
    const fifty = Array.from({ length: 50 }, () => OPEN);
    assert.deepStrictEqual(records([{ any: fifty }]).errors, []);
    const over = records([OPEN, { any: fifty }]).errors;
    assert.deepStrictEqual(codes(over), ['binding.filter_too_many@screens[0].x.props.source.filter']);
    assert.match(over[0].message, /51 clauses; the limit is 50/);
});

test('flat filters validate exactly as before', () => {
    assert.deepStrictEqual(records([OPEN, HIGH]).errors, []);
    assert.deepStrictEqual(codes(records(['bare']).errors), ['binding.filter_invalid@screens[0].x.props.source.filter[0]']);
});

function formulaFindings(/** @type {string} */ expr) {
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const warnings = [];
    validateFormula(expr, 'p', { pushE: (/** @type {any} */ r) => errors.push(r), pushW: (/** @type {any} */ r) => warnings.push(r) }, undefined);
    return { errors, warnings };
}

test('formula.each_without_it: a list function whose expression never reads it', () => {
    assert.deepStrictEqual(formulaFindings('filter(vars.rows, it.ok)').warnings, []);
    const plain = formulaFindings('filter(vars.rows, vars.ok)').warnings;
    assert.deepStrictEqual(plain.map((w) => w.code), ['formula.each_without_it']);
    assert.match(plain[0].hint, /it\.status/);
    const item = formulaFindings('map(vars.rows, item.name)').warnings;
    assert.deepStrictEqual(item.map((w) => w.code), ['formula.each_without_it']);
    assert.match(item[0].hint, /the item is it, not item/);
    assert.deepStrictEqual(formulaFindings('map(vars.rows, map(it.tags, it))').warnings, [], 'a nested body reading its own item is fine');
});

test('a refused regex pattern surfaces as formula.parse_error', () => {
    const { errors } = formulaFindings('regexMatch(form.x, "(a+)+")');
    assert.deepStrictEqual(errors.map((e) => e.code), ['formula.parse_error']);
    assert.match(errors[0].message, /repeated group/);
});

test('canonicalFilterList: or becomes any, a nested group is flattened, flat lists are untouched', () => {
    /** @type {Array<[string, string, string]>} */
    const hints = [];
    const push = (/** @type {string} */ code, /** @type {string} */ path, /** @type {string} */ msg) => { hints.push([code, path, msg]); };
    assert.deepStrictEqual(canonicalFilterList([{ or: [OPEN, HIGH] }], 'f', push), [{ any: [OPEN, HIGH] }]);
    assert.deepStrictEqual(canonicalFilterList([{ any: [OPEN, { any: [HIGH] }, { or: [OPEN] }] }], 'f', push), [{ any: [OPEN, HIGH, OPEN] }]);
    assert.deepStrictEqual(hints.map((h) => `${h[0]}@${h[1]}`), ['binding.filter_or_to_any@f[0]', 'binding.filter_any_flattened@f[0].any']);
    hints.length = 0;
    const flat = [OPEN, HIGH];
    const copy = canonicalFilterList(flat, 'f', push);
    assert.deepStrictEqual(copy, flat);
    assert.notStrictEqual(copy, flat, 'a copy, like deepCopy');
    assert.deepStrictEqual(hints, []);
    assert.deepStrictEqual(canonicalFilterList([{ field: 'x', or: [OPEN] }], 'f', push), [{ field: 'x', or: [OPEN] }], 'a clause with a field is left for the validator');
});
