'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [
    { region: 'north', amount: '10', weight: 1, day: '2026-01-02' },
    { region: 'North ', amount: '20', weight: 3, day: '2026-03-04' },
    { region: 'south', amount: '30', weight: 2, day: '2026-02-01' },
    { region: '', amount: '', weight: 'x', day: '' },
];
const agg = (fn, column, as) => ({ fn, ...(column ? { column } : {}), ...(as ? { as } : {}) });

test('group counts and sums per group; names merge ignoring case and spaces; blank group has null key', async () => {
    const { rows, keys } = await run([{ op: 'group', by: ['region'], aggregates: [agg('count', null, 'rows'), agg('sum', 'amount', 'total')] }], DATA);
    assert.deepEqual(keys, ['region', 'rows', 'total', 'n']);
    assert.deepEqual(rows, [
        { region: 'north', rows: 2, total: 30, n: 2 },
        { region: 'south', rows: 1, total: 30, n: 1 },
        { region: null, rows: 1, total: null, n: 1 },
    ]);
});

test('group mean, median, min, max, count_distinct, share, sort desc', async () => {
    const { rows } = await run([{ op: 'group', by: ['region'], sort: [{ column: 'total', dir: 'desc' }, { column: 'region', dir: 'asc' }], aggregates: [
        agg('sum', 'amount', 'total'), agg('mean', 'amount', 'avg'), agg('median', 'amount', 'med'), agg('min', 'day', 'first'), agg('max', 'day', 'last'),
        agg('count_distinct', 'day', 'days'), agg('share', null, 'pct'),
    ] }], DATA);
    assert.equal(rows[0].region, 'north');
    assert.deepEqual([rows[0].avg, rows[0].med, rows[0].first, rows[0].last, rows[0].days], [15, 15, '2026-01-02', '2026-03-04', 2]);
    assert.equal(rows[0].pct, 50);
    assert.equal(rows[2].region, null);
});

test('group weighted: count is the sum of weights, sum is sum of w*x, mean is weighted, share by weight', async () => {
    const data = DATA.slice(0, 3);
    const { rows, result } = await run([{ op: 'group', by: ['region'], weight: 'weight', aggregates: [agg('count', null, 'c'), agg('sum', 'amount', 's'), agg('mean', 'amount', 'm'), agg('share', null, 'p'), agg('median', 'amount', 'med')] }], data);
    const north = rows.find((r) => r.region === 'north');
    assert.deepEqual([north.c, north.s, north.m, north.p, north.n], [4, 10 + 60, 70 / 4, (100 * 4) / 6, 2]);
    assert.equal(north.med, 15);
    assert.equal(result.warnings.length, 0);
});

test('group warns about rows without a usable weight', async () => {
    const { result } = await run([{ op: 'group', by: ['region'], weight: 'weight', aggregates: [agg('count')] }], DATA);
    assert.ok(result.warningCodes.includes('weight_unusable'));
});

test('group minN blanks small groups, including their size, and says so', async () => {
    const { rows, keys, result } = await run([{ op: 'group', by: ['region'], minN: 2, aggregates: [agg('sum', 'amount', 'total')] }], DATA);
    assert.deepEqual(keys, ['region', 'total', 'n', 'suppressed']);
    assert.deepEqual(rows[0], { region: 'north', total: 30, n: 2, suppressed: false });
    assert.deepEqual(rows[1], { region: 'south', total: null, n: null, suppressed: true });
    assert.ok(result.warningCodes.includes('group_suppressed'));
});

test('group minN is raised to the organisation floor', async () => {
    const { rows } = await run([{ op: 'group', by: ['region'], minN: 1, aggregates: [agg('count')] }], DATA, { minGroupFloor: 2 });
    assert.equal(rows.filter((r) => r.suppressed).length, 2);
});

test('group without by gives one total row, even for no input', async () => {
    const a = await run([{ op: 'group', aggregates: [agg('count', null, 'rows')] }], DATA);
    assert.deepEqual(a.rows, [{ rows: 4, n: 4 }]);
    const b = await run([{ op: 'group', aggregates: [agg('count', null, 'rows')] }], [], { columnKeys: ['region'] });
    assert.deepEqual(b.rows, [{ rows: 0, n: 0 }]);
});

test('group over the group cap is table_too_many_groups', async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    await assert.rejects(run([{ op: 'group', by: ['id'], aggregates: [agg('count')] }], data, { limits: { maxGroups: 5 } }),
        (e) => e.errorClass === 'table_too_many_groups' && e.opId === 'op1');
});

test('group checks its configuration', async () => {
    const bad = (op) => assert.rejects(run([{ op: 'group', ...op }], DATA), (e) => e.errorClass === 'table_op_invalid');
    await bad({ aggregates: [] });
    await bad({ aggregates: [agg('sum')] });
    await bad({ aggregates: [agg('sum', 'ghost')] });
    await bad({ by: ['region'], aggregates: [agg('count', null, 'region')] });
    await bad({ aggregates: [agg('count')], sort: [{ column: 'ghost' }] });
});

test('a step that leaves minN at 0 still gets the organisation floor', async () => {
    const { rows, keys, result } = await run([{ op: 'group', by: ['region'], minN: 0, aggregates: [agg('count')] }], DATA, { minGroupFloor: 2 });
    assert.ok(keys.includes('suppressed'));
    assert.equal(rows.filter((r) => r.suppressed).length, 2);
    assert.ok(result.warningCodes.includes('group_suppressed'));
    const none = await run([{ op: 'group', by: ['region'], aggregates: [agg('count')] }], DATA, { minGroupFloor: 0 });
    assert.ok(!none.keys.includes('suppressed'));
});
