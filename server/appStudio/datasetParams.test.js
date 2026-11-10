/**
 * datasetParams: declarations, coercion and the resolution of `{ param }`
 * filter values. The rule that keeps existing datasets as they are is the
 * first test: without declared params the descriptor comes back as the same
 * object and every sent value is ignored.
 *
 * Run: cd server && node --test appStudio/datasetParams.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    resolveDatasetParams, validateDatasetParams, coerceParamValue, INVALID_PARAM,
    declaredParams, datasetEntry, paramCacheMaxEntries, DEFAULT_PARAM_CACHE_MAX,
    resolveBindingParamValues, isParamName, MAX_DATASET_PARAMS,
} = require('./datasetParams.mts');

const plain = {
    filters: [{ field: 'status', op: 'eq', value: 'open' }],
    groupBy: [{ field: 'region' }],
    aggregates: [{ fn: 'count', as: 'n' }],
};

const withParams = {
    params: [
        { name: 'region', type: 'text' },
        { name: 'minAmount', type: 'number', default: 10 },
        { name: 'since', type: 'date' },
    ],
    filters: [
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'region', op: 'eq', value: { param: 'region' } },
        { field: 'amount', op: 'gte', value: { param: 'minAmount' } },
        { any: [{ field: 'created_at', op: 'gte', value: { param: 'since' } }, { field: 'pinned', op: 'eq', value: true }] },
    ],
    aggregates: [{ fn: 'count', as: 'n' }],
};

test('a descriptor without declared params comes back as the same object; sent values are ignored', () => {
    for (const sent of [undefined, null, {}, { region: 'north' }, 'x', [1]]) {
        const r = resolveDatasetParams(plain, sent);
        assert.strictEqual(r.status, 'ok');
        assert.strictEqual(r.descriptor, plain, 'identity: the cache key and the SQL cannot move');
        assert.strictEqual(r.values, null);
    }
    // An empty list declares nothing either.
    const empty = { ...plain, params: [] };
    assert.strictEqual(resolveDatasetParams(empty, { a: 1 }).descriptor, empty);
});

test('declared params fill their clauses; literal clauses stay as written', () => {
    const r = resolveDatasetParams(withParams, { region: 'north', since: '2026-01-01' });
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.values, { region: 'north', minAmount: 10, since: '2026-01-01' });
    assert.deepStrictEqual(r.descriptor.filters, [
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'region', op: 'eq', value: 'north' },
        { field: 'amount', op: 'gte', value: 10 },
        { any: [{ field: 'created_at', op: 'gte', value: '2026-01-01' }, { field: 'pinned', op: 'eq', value: true }] },
    ]);
    assert.deepStrictEqual(r.descriptor.aggregates, withParams.aggregates);
});

test('an unset param without a default drops its clause, a group member drops alone', () => {
    const r = resolveDatasetParams(withParams, {});
    assert.deepStrictEqual(r.descriptor.filters, [
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'amount', op: 'gte', value: 10 },
        { any: [{ field: 'pinned', op: 'eq', value: true }] },
    ]);
});

test('a literal null value is not a missing param', () => {
    const d = { params: [{ name: 'p' }], filters: [{ field: 'x', op: 'eq', value: null }, { field: 'y', op: 'eq', value: { param: 'p' } }], aggregates: [] };
    assert.deepStrictEqual(resolveDatasetParams(d, {}).descriptor.filters, [{ field: 'x', op: 'eq', value: null }]);
});

test('a required clause whose param is unset stops the read', () => {
    const d = { params: [{ name: 'p' }], filters: [{ field: 'x', op: 'eq', value: { param: 'p' }, required: true }], aggregates: [] };
    assert.deepStrictEqual(resolveDatasetParams(d, {}), { status: 'required' });
    assert.deepStrictEqual(resolveDatasetParams(d, { p: 'a' }).descriptor.filters, [{ field: 'x', op: 'eq', value: 'a' }]);
});

test('values are coerced to the declared type; a misfit is invalid, an undeclared name ignored', () => {
    assert.deepStrictEqual(resolveDatasetParams(withParams, { minAmount: 'abc' }), { status: 'invalid', name: 'minAmount' });
    assert.deepStrictEqual(resolveDatasetParams(withParams, { since: 'not a date' }), { status: 'invalid', name: 'since' });
    assert.deepStrictEqual(resolveDatasetParams(withParams, { region: { $gt: '' } }), { status: 'invalid', name: 'region' });
    const r = resolveDatasetParams(withParams, { minAmount: '25', other: 'x', __proto__: { region: 'inherited' } });
    assert.deepStrictEqual(r.values, { minAmount: 25 });
});

test('coerceParamValue', () => {
    assert.strictEqual(coerceParamValue(undefined, 'text'), undefined);
    assert.strictEqual(coerceParamValue(null, 'number'), undefined);
    assert.strictEqual(coerceParamValue([], 'number'), undefined);
    assert.strictEqual(coerceParamValue(3, 'text'), '3');
    assert.strictEqual(coerceParamValue('x'.repeat(501), 'text'), INVALID_PARAM);
    assert.strictEqual(coerceParamValue(' 4.5 ', 'number'), 4.5);
    assert.strictEqual(coerceParamValue(Infinity, 'number'), INVALID_PARAM);
    assert.strictEqual(coerceParamValue('true', 'boolean'), true);
    assert.strictEqual(coerceParamValue('yes', 'boolean'), INVALID_PARAM);
    assert.deepStrictEqual(coerceParamValue(['1', 2], 'number'), [1, 2]);
    assert.strictEqual(coerceParamValue(['1', 'x'], 'number'), INVALID_PARAM);
    assert.strictEqual(coerceParamValue(new Array(201).fill('a'), 'text'), INVALID_PARAM);
    assert.strictEqual(coerceParamValue({ a: 1 }, 'text'), INVALID_PARAM);
});

test('validateDatasetParams: nothing to say about a descriptor without params', () => {
    assert.deepStrictEqual(validateDatasetParams(plain), []);
    assert.deepStrictEqual(validateDatasetParams(withParams), []);
    assert.deepStrictEqual(validateDatasetParams(null), []);
});

test('validateDatasetParams: declarations and references', () => {
    const errs = validateDatasetParams({
        params: [
            { name: '1bad' },
            { name: 'ok', type: 'colour' },
            { name: 'ok' },
            { name: 'n', type: 'number', default: 'x' },
            { name: 'l', label: 'x'.repeat(81), extra: 1 },
            'nope',
        ],
        filters: [
            { field: 'a', op: 'eq', value: { param: 'missing' } },
            { any: [{ field: 'b', op: 'eq', value: { param: 'ok', more: 1 } }] },
        ],
    });
    const joined = errs.join('\n');
    for (const bit of ['params[0].name', 'params[1].type', 'declared twice', 'params[3].default', 'params[4].label', 'params[4].extra', 'params[5] must be an object',
        'filters[0].value names parameter "missing"', 'filters[1].any[0].value: a parameter reference']) {
        assert.ok(joined.includes(bit), `expected "${bit}" in:\n${joined}`);
    }
    assert.ok(validateDatasetParams({ params: 'x' })[0].includes('must be a list'));
    const many = Array.from({ length: MAX_DATASET_PARAMS + 1 }, (_, i) => ({ name: `p${i}` }));
    assert.ok(validateDatasetParams({ params: many })[0].includes(`At most ${MAX_DATASET_PARAMS}`));
});

test('isParamName and declaredParams', () => {
    assert.ok(isParamName('_a1'));
    assert.ok(!isParamName(''));
    assert.ok(!isParamName('a-b'));
    assert.ok(!isParamName('x'.repeat(41)));
    assert.deepStrictEqual(declaredParams({ params: [{ name: 'a' }, { name: '-' }, null] }), [{ name: 'a' }]);
});

test('datasetEntry lists params only for a dataset that declares them', () => {
    assert.deepStrictEqual(datasetEntry({ id: 'd1', name: 'N', descriptor: plain }), { id: 'd1', name: 'N' });
    assert.deepStrictEqual(datasetEntry({ id: 'd2', name: 'P', descriptor: withParams }), { id: 'd2', name: 'P', params: ['region', 'minAmount', 'since'] });
});

test('paramCacheMaxEntries: generous default, 0 is unlimited, garbage keeps the default', () => {
    assert.strictEqual(paramCacheMaxEntries({}), DEFAULT_PARAM_CACHE_MAX);
    assert.strictEqual(paramCacheMaxEntries({ STUDIO_APP_DATASET_PARAM_CACHE_MAX: '0' }), 0);
    assert.strictEqual(paramCacheMaxEntries({ STUDIO_APP_DATASET_PARAM_CACHE_MAX: '25' }), 25);
    assert.strictEqual(paramCacheMaxEntries({ STUDIO_APP_DATASET_PARAM_CACHE_MAX: '-3' }), DEFAULT_PARAM_CACHE_MAX);
    assert.strictEqual(paramCacheMaxEntries({ STUDIO_APP_DATASET_PARAM_CACHE_MAX: 'many' }), DEFAULT_PARAM_CACHE_MAX);
});

test('resolveBindingParamValues: formulas evaluated, undefined left out, skip propagates', () => {
    const SKIP = Symbol('skip');
    const evalF = (f) => (f.expr === 'vars.r' ? 'north' : f.expr === 'gone' ? undefined : SKIP);
    assert.strictEqual(resolveBindingParamValues(undefined, evalF, SKIP), undefined);
    assert.deepStrictEqual(resolveBindingParamValues({ a: { kind: 'formula', expr: 'vars.r' }, b: 2, c: { kind: 'formula', expr: 'gone' } }, evalF, SKIP), { a: 'north', b: 2 });
    assert.strictEqual(resolveBindingParamValues({ a: { kind: 'formula', expr: 'item.x' } }, evalF, SKIP), SKIP);
});
