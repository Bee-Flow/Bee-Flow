/**
 * A table handle where a Loop expects a list (handleRows.mts): the rows of the
 * stored table, through the store's own authorisation, capped; anything else
 * passes through untouched.
 *
 * Run: node --test core/automationRunner/tables/handleRows.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsOfTableValue } = require('./handleRows.mts');

const HANDLE = { kind: 'table', tableId: `rtb_${'c'.repeat(32)}`, columns: [], rowCount: 3 };
const ROWS = [{ a: 1 }, { a: 2 }, { a: 3 }];
const deps = (opened = { rows: () => ROWS }) => ({
    isTableHandle: (v) => !!v && typeof v === 'object' && v.kind === 'table',
    openTable: async (h, scope) => (h.tableId === HANDLE.tableId && scope.runId === 'r1' ? opened : null),
});
const ctx = { runId: 'r1', automationId: 'a1', userId: 'u1' };

test('a list, a value and a missing value pass through as they came', async () => {
    for (const v of [[1, 2], 'text', undefined, null, { rows: [1] }]) assert.equal(await rowsOfTableValue(v, ctx, 10, deps()), v);
});

test('a handle, or { table: handle }, is the rows of its table', async () => {
    assert.deepEqual(await rowsOfTableValue(HANDLE, ctx, 10, deps()), ROWS);
    assert.deepEqual(await rowsOfTableValue({ table: HANDLE, rowCount: 3 }, ctx, 0, deps()), ROWS, '0 = no cap');
});

test('a dry-run handle is its (empty) preview; a table of another run is not found; past the cap fails', async () => {
    assert.deepEqual(await rowsOfTableValue({ ...HANDLE, tableId: 'dry-run', preview: [] }, ctx, 10, deps()), []);
    await assert.rejects(rowsOfTableValue(HANDLE, { ...ctx, runId: 'r2' }, 10, deps()), (e) => e.errorClass === 'table_not_found');
    await assert.rejects(rowsOfTableValue(HANDLE, ctx, 2, deps()), (e) => e.errorClass === 'collection_too_large');
});
