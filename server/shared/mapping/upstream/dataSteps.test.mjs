/**
 * dataSteps.mjs: a datatable step's output shape at design time.
 *
 * describeNode is the design-time output-shape authority: a step type it
 * does not describe contributes NO group to the variable picker, so nothing
 * downstream can bind to its output through any picker, drag, auto-map or the
 * input panel, and nothing errors. That silence is what this file prevents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeNode } from './index.mjs';

const CATALOG = {
    datatables: [{
        id: 'tbl_aaaaaa',
        name: 'Customers',
        columns: [
            { key: 'email', name: 'Email', type: 'text' },
            { key: 'signups', name: 'Signups', type: 'number' },
            { key: 'active', name: 'Active', type: 'bool' },
            { key: 'joined', name: 'Joined', type: 'datetime' },
        ],
    }],
};

const node = (over = {}) => ({ id: 's1', type: 'datatable', datatableId: 'tbl_aaaaaa', op: 'find_rows', ...over });
const describe_ = (n) => describeNode(n, { steps: [n] }, {}, {}, null, CATALOG);

test('a datatable step contributes a group rather than null', () => {
    const g = describe_(node());
    assert.ok(g);
    assert.equal(g.id, 's1');
    assert.equal(g.basePath, 'steps.s1.output');
    assert.equal(g.kind, 'datatable');
});

test('the group is named after the table, unless the author labelled the step', () => {
    assert.equal(describe_(node()).label, 'Customers');
    assert.equal(describe_(node({ label: 'Look up the customer' })).label, 'Look up the customer');
});

test('find_rows exposes rows, returned, found, hasMore and the cursor for the next page', () => {
    const keys = Object.keys(describe_(node()).sample);
    for (const k of ['rows', 'returned', 'found', 'hasMore', 'nextCursor']) assert.ok(keys.includes(k), k);
});

test('find_rows no longer offers `count`: it never meant "how many rows match"', () => {
    // It was rows.length CLAMPED BY THE PAGE SIZE, so a condition on
    // `count > 100` after a default page of 50 could never fire. The runtime
    // still resolves it for one release; the picker must stop teaching it,
    // and count_rows answers the real question.
    assert.ok(!Object.keys(describe_(node()).sample).includes('count'));
    assert.deepStrictEqual(Object.keys(describe_(node({ op: 'count_rows' })).sample), ['count', 'found']);
});

test('the find_rows row carries every declared column and the system columns', () => {
    const row = describe_(node()).sample.rows[0];
    for (const k of ['email', 'signups', 'active', 'joined']) assert.ok(k in row, k);
    assert.notEqual(row.id, undefined);
    assert.notEqual(row.created_at, undefined);
});

test('samples come from column TYPES, never from real rows', () => {
    const row = describe_(node()).sample.rows[0];
    assert.equal(typeof row.email, 'string');
    assert.equal(typeof row.signups, 'number');
    assert.equal(typeof row.active, 'boolean');
    // A definition is a portable document; a sample drawn from live rows
    // would put customer data into it.
    assert.doesNotMatch(row.email, /@/);
});

test('add_row and save_row expose the row, the created flag and the written id', () => {
    // The id is returned at the top level as well as inside `row`: the next
    // step almost always needs it, and reaching through `row` is one
    // indirection nobody guesses.
    for (const op of ['add_row', 'save_row']) {
        const s = describe_(node({ op })).sample;
        assert.ok('row' in s && 'created' in s, op);
        assert.notEqual(s.id, undefined);
        assert.notEqual(s.row.id, undefined);
    }
});

test('update_rows and delete_rows expose a count and whether they ran out of room, not a row', () => {
    // `truncated` is bindable because a partial write that reports success is
    // exactly what an author needs to branch on.
    assert.deepStrictEqual(Object.keys(describe_(node({ op: 'update_rows' })).sample), ['updated', 'truncated']);
    assert.deepStrictEqual(Object.keys(describe_(node({ op: 'delete_rows' })).sample), ['deleted', 'truncated']);
});

test('it degrades rather than breaking: no catalog, or no table picked, still yields a group', () => {
    const g = describeNode(node(), { steps: [] }, {}, {}, null, null);
    assert.ok(g);
    assert.notEqual(g.sample.rows[0].id, undefined);
    assert.ok(describe_(node({ datatableId: '' })));
});
