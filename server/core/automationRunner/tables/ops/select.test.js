'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [{ region: 'north', month: '2026-01', amount: 10 }, { region: 'south', month: '2026-02', amount: 20 }];

test('select keep fixes the order and drops the rest', async () => {
    const { rows, keys } = await run([{ op: 'select', keep: ['amount', 'region'] }], DATA);
    assert.deepEqual(keys, ['amount', 'region']);
    assert.deepEqual(rows[0], { amount: 10, region: 'north' });
});

test('select drop removes columns; names match ignoring case', async () => {
    const { keys } = await run([{ op: 'select', drop: ['MONTH'] }], DATA);
    assert.deepEqual(keys, ['region', 'amount']);
});

test('select rename changes key and label, a clash gets a suffix', async () => {
    const { rows, columns } = await run([{ op: 'select', rename: [{ from: 'amount', to: 'region' }] }], DATA);
    assert.deepEqual(columns.map((c) => c.key), ['region', 'month', 'region (2)']);
    assert.equal(columns[2].label, 'region (2)');
    assert.equal(rows[0]['region (2)'], 10);
});

test('select with both keep and drop is table_op_invalid', async () => {
    await assert.rejects(run([{ op: 'select', keep: ['region'], drop: ['month'] }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.opId === 'op1');
});

test('select with an unknown column names the field', async () => {
    await assert.rejects(run([{ op: 'select', keep: ['region', 'nope'] }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.field === 'keep[1]' && /nope/.test(e.message));
});
