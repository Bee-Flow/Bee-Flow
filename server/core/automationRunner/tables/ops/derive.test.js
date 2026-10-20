'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [{ region: 'north', amount: 10, weight: 2 }, { region: 'south', amount: 5, weight: 4 }];

test('derive adds columns from formula, template, reference and literal', async () => {
    const { rows, keys } = await run([{ op: 'derive', columns: [
        { name: 'total', value: { kind: 'expr', value: 'row.amount * row.weight' } },
        { name: 'label', value: { kind: 'template', value: '{{row.region}} #{{rowIndex}}' } },
        { name: 'copy', value: { kind: 'ref', path: 'row.region' } },
        { name: 'fixed', value: { kind: 'literal', value: 'x' } },
        { name: 'bare', value: 7 },
        { name: 'fromVar', value: { kind: 'ref', path: 'vars.threshold' } },
    ] }], DATA, { runState: { vars: { threshold: 3 } } });
    assert.deepEqual(keys, ['region', 'amount', 'weight', 'total', 'label', 'copy', 'fixed', 'bare', 'fromVar']);
    assert.deepEqual(rows[1], { region: 'south', amount: 5, weight: 4, total: 20, label: 'south #1', copy: 'south', fixed: 'x', bare: 7, fromVar: 3 });
});

test('derive can build on a column made earlier in the same step, and replace an existing one', async () => {
    const { rows, keys } = await run([{ op: 'derive', columns: [
        { name: 'double', value: { kind: 'expr', value: 'row.amount * 2' } },
        { name: 'quad', value: { kind: 'expr', value: 'row.double * 2' } },
        { name: 'amount', value: { kind: 'literal', value: 0 } },
    ] }], DATA);
    assert.deepEqual(keys, ['region', 'amount', 'weight', 'double', 'quad']);
    assert.deepEqual(rows.map((r) => [r.double, r.quad, r.amount]), [[20, 40, 0], [10, 20, 0]]);
});

test('derive does not change the rows of the input', async () => {
    const { rows } = await run([{ op: 'derive', columns: [{ name: 'x', value: 1 }] }, { op: 'select', drop: ['x'] }], DATA);
    assert.deepEqual(Object.keys(rows[0]), ['region', 'amount', 'weight']);
});

test('derive turns lists and records into text and NaN into null', async () => {
    const { rows } = await run([{ op: 'derive', columns: [
        { name: 'list', value: { kind: 'ref', path: 'vars.list' } },
        { name: 'record', value: { kind: 'ref', path: 'vars.record' } },
        { name: 'bad', value: { kind: 'expr', value: '0/0' } },
    ] }], DATA, { runState: { vars: { list: [1, 2], record: { a: 1 } } } });
    assert.equal(rows[0].list, '1; 2');
    assert.equal(rows[0].record, '{"a":1}');
    assert.equal(rows[0].bad, null);
});

test('derive with a formula that cannot be read fails naming the field, never a value', async () => {
    await assert.rejects(run([{ op: 'derive', columns: [{ name: 'x', value: { kind: 'expr', value: 'row.amount +' } }] }], DATA),
        (e) => e.errorClass === 'table_op_invalid' && e.field === 'columns[0].value');
});

test('derive needs a name per column', async () => {
    await assert.rejects(run([{ op: 'derive', columns: [{ name: ' ', value: 1 }] }], DATA), (e) => e.errorClass === 'table_op_invalid');
});
