'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [
    ...Array.from({ length: 6 }, () => ({ region: 'north', month: 'jan', amount: 10, weight: 1 })),
    ...Array.from({ length: 2 }, () => ({ region: 'north', month: 'feb', amount: 20, weight: 1 })),
    ...Array.from({ length: 4 }, () => ({ region: 'south', month: 'jan', amount: 5, weight: 2 })),
    ...Array.from({ length: 8 }, () => ({ region: 'south', month: 'feb', amount: 15, weight: 1 })),
    { region: '', month: 'feb', amount: 1, weight: 1 },
];
const pv = (extra = {}) => ({ op: 'pivot', rows: 'region', columns: 'month', ...extra });

test('pivot counts with row and column totals, a Total row last, and a label for empty values', async () => {
    const { rows, keys } = await run([pv()], DATA);
    assert.deepEqual(keys, ['region', 'jan', 'feb', 'Total']);
    assert.deepEqual(rows, [
        { region: 'north', jan: 6, feb: 2, Total: 8 },
        { region: 'south', jan: 4, feb: 8, Total: 12 },
        { region: '(empty)', jan: 0, feb: 1, Total: 1 },
        { region: 'Total', jan: 10, feb: 11, Total: 21 },
    ]);
});

test('pivot without totals', async () => {
    const { rows, keys } = await run([pv({ totals: false })], DATA);
    assert.deepEqual(keys, ['region', 'jan', 'feb']);
    assert.equal(rows.length, 3);
});

test('pivot sum and mean, weighted', async () => {
    const sum = await run([pv({ value: { fn: 'sum', column: 'amount' } })], DATA);
    assert.equal(sum.rows[0].jan, 60);
    const mean = await run([pv({ value: { fn: 'mean', column: 'amount' }, weight: 'weight', totals: false })], DATA);
    assert.equal(mean.rows[1].jan, 5);
    const w = await run([pv({ weight: 'weight', totals: false })], DATA);
    assert.equal(w.rows[1].jan, 8);
});

test('pivot percent of row, column and total', async () => {
    const row = await run([pv({ percent: 'row', decimals: 1 })], DATA);
    assert.deepEqual([row.rows[0].jan, row.rows[0].feb, row.rows[0].Total], [75, 25, 100]);
    assert.equal(row.rows[3].jan, 47.6);
    const col = await run([pv({ percent: 'column', decimals: 0 })], DATA);
    assert.deepEqual([col.rows[0].jan, col.rows[1].jan, col.rows[3].jan, col.rows[0].Total], [60, 40, 100, 38]);
    const tot = await run([pv({ percent: 'total', decimals: 2 })], DATA);
    assert.equal(tot.rows[3].Total, 100);
    assert.equal(tot.rows[0].jan, 28.57);
});

test('pivot columnOrder puts listed values first', async () => {
    const { keys } = await run([pv({ columnOrder: ['feb', 'jan'] })], DATA);
    assert.deepEqual(keys, ['region', 'feb', 'jan', 'Total']);
});

test('pivot caps the columns and adds up the rest under Other', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ r: i % 2 ? 'a' : 'b', c: `c${i % 6}`, v: 1 }));
    const { rows, keys, result } = await run([{ op: 'pivot', rows: 'r', columns: 'c' }], data, { limits: { pivotMaxColumns: 4 } });
    assert.equal(keys.length, 1 + 3 + 1 + 1);
    assert.ok(keys.includes('Other'));
    assert.equal(rows[rows.length - 1].Total, 30);
    assert.ok(result.warningCodes.includes('pivot_columns_capped'));
});

test('pivot blanks small cells and the totals that would reveal them', async () => {
    const { rows, result } = await run([pv({ minN: 3 })], DATA);
    const empty = rows.find((r) => r.region === '(empty)');
    assert.equal(empty.feb, null);
    assert.equal(empty.Total, null);
    assert.equal(rows[0].feb, null);
    assert.equal(rows[0].Total, null);
    assert.equal(rows[1].jan, 4);
    assert.equal(rows[1].Total, 12);
    assert.ok(result.warningCodes.includes('pivot_suppressed'));
    assert.ok(!JSON.stringify(result.warnings).includes('"1"'));
});

test('pivot checks its configuration', async () => {
    const bad = (op) => assert.rejects(run([op], DATA), (e) => e.errorClass === 'table_op_invalid');
    await bad({ op: 'pivot', columns: 'month' });
    await bad({ op: 'pivot', rows: 'region', columns: 'region' });
    await bad({ op: 'pivot', rows: 'region', columns: 'ghost' });
    await bad(pv({ value: { fn: 'sum' } }));
});

test('pivot over the group cap is table_too_many_groups', async () => {
    await assert.rejects(run([pv()], DATA, { limits: { maxGroups: 1 } }), (e) => e.errorClass === 'table_too_many_groups');
});

test('a pivot that leaves minN at 0 still gets the organisation floor', async () => {
    const floored = await run([pv()], DATA, { minGroupFloor: 3 });
    assert.ok(floored.result.warningCodes.includes('pivot_suppressed'));
    assert.equal(floored.rows[0].feb, null);
    const open = await run([pv()], DATA, { minGroupFloor: 0 });
    assert.ok(!open.result.warningCodes.includes('pivot_suppressed'));
});
