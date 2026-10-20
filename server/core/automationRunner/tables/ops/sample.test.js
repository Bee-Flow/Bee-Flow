'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = Array.from({ length: 200 }, (_, i) => ({ id: i }));

test('sample first n takes the first rows', async () => {
    const { rows } = await run([{ op: 'sample', n: 5 }], DATA);
    assert.deepEqual(rows.map((r) => r.id), [0, 1, 2, 3, 4]);
});

test('sample first percent takes the first share', async () => {
    const { rows } = await run([{ op: 'sample', percent: 10 }], DATA);
    assert.equal(rows.length, 20);
});

test('sample random n is repeatable, exactly n, in original order', async () => {
    const a = await run([{ op: 'sample', mode: 'random', n: 15, seed: 'x' }], DATA);
    const b = await run([{ op: 'sample', mode: 'random', n: 15, seed: 'x' }], DATA);
    const c = await run([{ op: 'sample', mode: 'random', n: 15, seed: 'y' }], DATA);
    assert.equal(a.rows.length, 15);
    assert.deepEqual(a.rows, b.rows);
    assert.notDeepEqual(a.rows, c.rows);
    const ids = a.rows.map((r) => r.id);
    assert.deepEqual(ids, ids.slice().sort((x, y) => x - y));
});

test('sample random percent is repeatable and roughly the share', async () => {
    const a = await run([{ op: 'sample', mode: 'random', percent: 50 }], DATA);
    const b = await run([{ op: 'sample', mode: 'random', percent: 50 }], DATA);
    assert.deepEqual(a.rows, b.rows);
    assert.ok(a.rows.length > 60 && a.rows.length < 140);
});

test('sample needs exactly one of n and percent', async () => {
    await assert.rejects(run([{ op: 'sample' }], DATA), (e) => e.errorClass === 'table_op_invalid');
    await assert.rejects(run([{ op: 'sample', n: 3, percent: 10 }], DATA), (e) => e.errorClass === 'table_op_invalid');
});
