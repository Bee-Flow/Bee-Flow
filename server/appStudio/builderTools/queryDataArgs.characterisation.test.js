'use strict';
/**
 * parseQueryArgs, pinned per argument: each case is one app_query_data call,
 * the golden holds the exact answer (key order included, as JSON), so a
 * refusal that moves ahead of another or a field that changes shape shows.
 *
 * Refresh (only for a deliberate change):
 *   cd server && UPDATE_GOLDEN=1 node --test appStudio/builderTools/queryDataArgs.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseQueryArgs } = require('./queryDataArgs');

const GOLDEN_PATH = path.join(__dirname, 'queryDataArgs.characterisation.golden.json');
const T = { tableId: 'tbl_a' };
const CASES = {
    'no arguments': undefined,
    'not an object': 'x',
    'both sources': { tableId: 'tbl_a', datasetId: 'ds_a' },
    'empty source ids': { tableId: '', datasetId: '' },
    'table only': T,
    'dataset only': { datasetId: 'ds_a', cursor: 'abc' },
    'limit given': { ...T, limit: 50 },
    'limit as text': { ...T, limit: '7' },
    'limit clamped': { ...T, limit: 1000 },
    'limit zero': { ...T, limit: 0 },
    'limit fraction': { ...T, limit: 2.5 },
    'limit null': { ...T, limit: null },
    'sort default dir': { ...T, sort: { field: 'due' } },
    'sort upper dir': { ...T, sort: { field: 'due', dir: 'ASC' } },
    'sort bad dir': { ...T, sort: { field: 'due', dir: 'up' } },
    'sort no field': { ...T, sort: { dir: 'asc' } },
    'sort array': { ...T, sort: [{ field: 'due' }] },
    'sort string': { ...T, sort: 'due' },
    'sort null dir': { ...T, sort: { field: 'due', dir: null } },
    'orderBy': { ...T, orderBy: [{ field: 'a', dir: 'asc' }] },
    'orderBy with sort': { ...T, sort: { field: 'due' }, orderBy: [{ field: 'a' }] },
    'orderBy empty': { ...T, orderBy: [] },
    'filter': { ...T, filter: [{ field: 'a', op: 'eq', value: 1 }] },
    'filter object': { ...T, filter: { field: 'a' } },
    'match any': { ...T, match: 'any' },
    'match bad': { ...T, match: 'some' },
    'search': { ...T, search: { value: 'x', fields: ['a'] } },
    'search no fields': { ...T, search: { value: 'x', fields: [] } },
    'search empty value': { ...T, search: { value: '', fields: ['a'] } },
    'cursor number': { ...T, cursor: 5 },
    'cursor empty': { ...T, cursor: '' },
    'total true': { ...T, total: true },
    'total false': { ...T, total: false },
    'total text': { ...T, total: 'yes' },
    'params': { ...T, params: { a: 1 } },
    'params array': { ...T, params: [1] },
    'expand and fields': { ...T, expand: [{ field: 'r' }], fields: ['a'] },
    'expand empty': { ...T, expand: [] },
    'fields not a list': { ...T, fields: 'a' },
    'first refusal wins': { ...T, limit: -1, sort: 'x', match: 'x', cursor: 5 },
    'everything': { ...T, limit: 300, sort: { field: 'a', dir: 'desc' }, filter: [], match: 'all', search: { value: 'q', fields: ['a', 'b'] }, cursor: 'c1', total: true, params: { p: 1 }, expand: [{ field: 'r' }], fields: ['a'] },
};

// A key present with an undefined value is part of the answer too.
const asJson = (v) => JSON.stringify(v, (_k, x) => (x === undefined ? '$undefined' : x));
const actual = Object.fromEntries(Object.entries(CASES).map(([name, args]) => [name, asJson(parseQueryArgs(args))]));
if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 1)}\n`);
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

test('every case is in the golden file', () => {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(GOLDEN).sort());
});
for (const name of Object.keys(actual)) {
    test(`golden: ${name}`, () => assert.equal(actual[name], GOLDEN[name]));
}
