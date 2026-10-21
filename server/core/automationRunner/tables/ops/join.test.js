'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, cols } = require('./testKit');

const LEFT = [{ id: 'A1', region: 'north' }, { id: ' a2 ', region: 'south' }, { id: 'B7', region: 'east' }, { id: '', region: 'none' }];
const RIGHT = [
    { code: 'a1', owner: 'Person One', region: 'x' },
    { code: 'A2', owner: 'Person Two', region: 'y' },
    { code: 'A2', owner: 'Person Three', region: 'z' },
    { code: null, owner: 'Nobody', region: 'q' },
];
const resolver = (rows = RIGHT, columnKeys = ['code', 'owner', 'region']) => async () => ({ columns: cols(...columnKeys), rows: () => rows });
const join = (extra = {}) => ({ op: 'join', with: { kind: 'ref', path: 'steps.other.output.table' }, on: [{ left: 'id', right: 'code' }], ...extra });

test('left join matches ignoring case and spaces, keeps unmatched rows, and names collisions', async () => {
    const { rows, keys, result } = await run([join()], LEFT, { resolveTable: resolver() });
    assert.deepEqual(keys, ['id', 'region', 'owner', 'region (2)']);
    assert.deepEqual(rows.map((r) => r.owner), ['Person One', 'Person Two', null, null]);
    assert.equal(rows[0]['region (2)'], 'x');
    assert.equal(result.opStats[0].unmatched, 2);
    assert.ok(result.warningCodes.includes('join_unmatched'));
});

test('inner join drops rows without a match', async () => {
    const { rows } = await run([join({ how: 'inner' })], LEFT, { resolveTable: resolver() });
    assert.deepEqual(rows.map((r) => r.id), ['A1', ' a2 ']);
});

test('join onDuplicate first (default) or all', async () => {
    const first = await run([join()], LEFT, { resolveTable: resolver() });
    assert.equal(first.rows.length, 4);
    const all = await run([join({ onDuplicate: 'all' })], LEFT, { resolveTable: resolver() });
    assert.equal(all.rows.length, 5);
    assert.deepEqual(all.rows.filter((r) => r.region === 'south').map((r) => r.owner), ['Person Two', 'Person Three']);
});

test('join finds key columns by alternatives, case-insensitively, on both sides', async () => {
    const op = join({ on: [{ left: 'identifier', right: 'Code', alternatives: ['ID', 'key'] }] });
    const { rows } = await run([op], LEFT, { resolveTable: resolver() });
    assert.equal(rows[0].owner, 'Person One');
});

test('join picks columns, with a prefix; case-sensitive matching when asked', async () => {
    const left = [{ id: 'a1' }, { id: 'A1' }, { id: ' A2 ' }];
    const { rows, keys } = await run([join({ columns: ['owner'], prefix: 'other ', caseInsensitive: false })], left, { resolveTable: resolver() });
    assert.deepEqual(keys, ['id', 'other owner']);
    assert.deepEqual(rows.map((r) => r['other owner']), ['Person One', null, 'Person Two']);
});

test('join on two columns', async () => {
    const left = [{ a: '1', b: 'x' }, { a: '1', b: 'y' }];
    const right = [{ a: '1', b: 'y', v: 'hit' }];
    const op = { op: 'join', with: {}, on: [{ left: 'a', right: 'a' }, { left: 'b', right: 'b' }] };
    const { rows } = await run([op], left, { resolveTable: resolver(right, ['a', 'b', 'v']) });
    assert.deepEqual(rows.map((r) => r.v), [null, 'hit']);
});

test('join with too many right rows is table_join_too_large', async () => {
    await assert.rejects(run([join()], LEFT, { resolveTable: resolver(), limits: { joinMaxRightRows: 2 } }), (e) => e.errorClass === 'table_join_too_large' && e.opId === 'op1');
});

test('join with an unknown key column names the side', async () => {
    await assert.rejects(run([join({ on: [{ left: 'id', right: 'ghost' }] })], LEFT, { resolveTable: resolver() }), (e) => e.errorClass === 'table_op_invalid' && e.field === 'on[0].right');
    await assert.rejects(run([join({ on: [] })], LEFT, { resolveTable: resolver() }), (e) => e.errorClass === 'table_op_invalid');
});

test('join asks for its table with the id of its own operation', async () => {
    const asked = [];
    const resolveTable = async (binding, opId) => { asked.push(opId); return { columns: cols('code', 'owner'), rows: () => RIGHT }; };
    await run([{ ...join(), id: 'j1' }, { ...join({ prefix: 'b ' }), id: 'j2' }], LEFT, { resolveTable });
    assert.deepEqual(asked, ['j1', 'j2']);
});
