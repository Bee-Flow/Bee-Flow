// @typecheck strict
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RULE_TESTS, normalizeRules, compileRule } = require('./rules');

const check = (/** @type {string} */ test_, /** @type {unknown} */ value, /** @type {unknown} */ cell, extra = {}) => compileRule({ test: test_, value, ...extra })(cell);

test('the vocabulary is complete', () => {
    assert.deepEqual(RULE_TESTS, ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty', 'contains_item']);
});

test('equals / not_equals ignore case and surrounding spaces and read numbers as numbers', () => {
    assert.equal(check('equals', 'North', '  nOrTh '), true);
    assert.equal(check('equals', 5, '5'), true);
    assert.equal(check('equals', '007', '7'), false);
    assert.equal(check('equals', 'x', null), false);
    assert.equal(check('equals', '', '  '), true);
    assert.equal(check('equals', '', 'a'), false);
    assert.equal(check('not_equals', 'a', 'b'), true);
    assert.equal(check('not_equals', 'a', ' A '), false);
});

test('contains, starts_with, ends_with ignore case; blanks never match', () => {
    assert.equal(check('contains', 'ORT', 'North'), true);
    assert.equal(check('contains', 'x', null), false);
    assert.equal(check('not_contains', 'x', null), true);
    assert.equal(check('not_contains', 'rth', 'North'), false);
    assert.equal(check('starts_with', 'no', ' North'), true);
    assert.equal(check('ends_with', 'TH', 'North'), true);
    assert.equal(check('starts_with', 'th', 'North'), false);
});

test('in / not_in take a list', () => {
    assert.equal(check('in', ['a', 'B'], 'b'), true);
    assert.equal(check('in', ['a', 'B'], 'c'), false);
    assert.equal(check('in', [1, 2], '2'), true);
    assert.equal(check('not_in', ['a'], 'c'), true);
    assert.equal(check('not_in', ['a'], null), true);
    assert.equal(check('in', ['a'], ''), false);
});

test('numeric tests parse like a spreadsheet: decimal comma, grouping, percent', () => {
    assert.equal(check('gt', 7, '7,5'), true);
    assert.equal(check('gte', 7.5, '7,5'), true);
    assert.equal(check('lt', 1000, '1.234,5'), false);
    assert.equal(check('lte', '1,234.5', '1234.5'), true);
    assert.equal(check('gt', 0.4, '50%'), true);
    assert.equal(check('lt', 3, 'abc'), false);
    assert.equal(check('gt', 3, ''), false);
    assert.equal(check('gt', 'x', 4), false);
});

test('numeric tests fall back to ISO dates', () => {
    assert.equal(check('gt', '2026-01-01', '2026-03-01'), true);
    assert.equal(check('lt', '2026-01-01', '2026-03-01T10:00:00.000Z'), false);
    assert.equal(check('gte', '2026-03-01', '2026-03-01T00:00:00.000Z'), true);
    assert.equal(check('gt', '2026-01-01', 5), false);
});

test('between is inclusive on both ends', () => {
    assert.equal(check('between', [1, 5], 1), true);
    assert.equal(check('between', [1, 5], '5'), true);
    assert.equal(check('between', [1, 5], 5.1), false);
    assert.equal(check('between', ['2026-01-01', '2026-01-31'], '2026-01-15'), true);
});

test('is_empty / is_not_empty', () => {
    assert.equal(check('is_empty', undefined, null), true);
    assert.equal(check('is_empty', undefined, '  '), true);
    assert.equal(check('is_empty', undefined, 0), false);
    assert.equal(check('is_not_empty', undefined, 'x'), true);
    assert.equal(check('is_not_empty', undefined, ''), false);
});

test('contains_item splits on the separator (default ;) and trims', () => {
    assert.equal(check('contains_item', 'Rain', 'sun; rain ;wind', { separator: ';' }), true);
    assert.equal(check('contains_item', 'ra', 'sun;rain'), false);
    assert.equal(check('contains_item', 'b', 'a|b', { separator: '|' }), true);
    assert.equal(check('contains_item', 'a', null, { separator: ';' }), false);
});

test('normalizeRules keeps valid rules and names the broken ones by position', () => {
    const { rules, errors } = normalizeRules([
        { column: ' region ', test: 'equals', value: 'x' },
        { column: '', test: 'equals', value: 'x' },
        { column: 'a', test: 'sounds_like', value: 'x' },
        { column: 'a', test: 'equals' },
        { column: 'a', test: 'between', value: [1] },
        { column: 'a', test: 'in', value: [] },
        'nope',
        { column: 'a', test: 'is_empty', value: 'ignored' },
        { column: 'a', test: 'contains_item', value: 'x' },
        { column: 'a', test: 'in', value: 'single' },
        { column: 'a', test: 'equals', value: { kind: 'ref', path: 'vars.x' } },
    ]);
    assert.deepEqual(errors.map((e) => [e.index, e.field]), [[1, 'column'], [2, 'test'], [3, 'value'], [4, 'value'], [5, 'value'], [6, 'rule']]);
    assert.deepEqual(rules.map((r) => r.test), ['equals', 'is_empty', 'contains_item', 'in', 'equals']);
    assert.equal(rules[0].column, 'region');
    assert.deepEqual(rules[1], { column: 'a', test: 'is_empty' });
    assert.equal(rules[2].separator, ';');
    assert.deepEqual(rules[3].value, ['single']);
});

test('normalizeRules of nothing is nothing; of a non-list is one error', () => {
    assert.deepEqual(normalizeRules(undefined), { rules: [], errors: [] });
    assert.equal(normalizeRules({}).errors.length, 1);
});
