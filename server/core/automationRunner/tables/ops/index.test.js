'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, table, collect, LIMITS } = require('./testKit');
const { runTableOps } = require('./index');
const { normalizeOp } = require('../../../automationModel/tableOps/spec');

const DATA = Array.from({ length: 20 }, (_, i) => ({ region: i % 2 ? 'north' : 'south', amount: i }));

test('operations run in order and report what went in and out', async () => {
    const { rows, result, keys } = await run([
        { id: 'keep', op: 'filter', rules: [{ column: 'region', test: 'equals', value: 'north' }] },
        { id: 'sum', op: 'group', by: ['region'], aggregates: [{ fn: 'sum', column: 'amount', as: 'total' }] },
    ], DATA);
    assert.deepEqual(keys, ['region', 'total', 'n']);
    assert.deepEqual(rows, [{ region: 'north', total: 100, n: 10 }]);
    const [a, b] = result.opStats;
    assert.deepEqual([a.opId, a.op, a.enabled, a.ok, a.inputRows, a.outputRows, a.columns], ['keep', 'filter', true, true, 20, 10, ['region', 'amount']]);
    assert.deepEqual([b.inputRows, b.outputRows, b.columns], [10, 1, ['region', 'total', 'n']]);
});

test('a disabled operation is reported but does nothing', async () => {
    const { rows, result } = await run([
        { id: 'off', enabled: false, op: 'filter', rules: [{ column: 'region', test: 'equals', value: 'zzz' }] },
        { id: 'two', op: 'sample', n: 3 },
    ], DATA);
    assert.equal(rows.length, 3);
    assert.deepEqual(result.opStats.map((s) => [s.opId, s.enabled]), [['off', false], ['two', true]]);
});

test('upToOpId stops after that operation; an unknown id is an error', async () => {
    const ops = [{ id: 'a', op: 'sample', n: 10 }, { id: 'b', op: 'sample', n: 2 }];
    const { rows, result } = await run(ops, DATA, { upToOpId: 'a' });
    assert.equal(rows.length, 10);
    assert.equal(result.opStats.length, 1);
    await assert.rejects(run(ops, DATA, { upToOpId: 'zzz' }), (e) => e.errorClass === 'table_op_invalid' && e.field === 'upToOpId');
});

test('the rows can be read twice and give the same result and stats', async () => {
    const { result } = await run([{ op: 'filter', rules: [{ column: 'amount', test: 'gte', value: 15 }] }, { op: 'sample', mode: 'random', n: 3 }], DATA);
    const a = await collect(result.rows);
    const b = await collect(result.rows);
    assert.deepEqual(a, b);
    assert.equal(result.opStats[0].inputRows, 20);
});

test('an error carries the class, the operation and the field, and the stats show the failure', async () => {
    await assert.rejects(run([{ id: 'ok', op: 'sample', n: 5 }, { id: 'bad', op: 'select', keep: ['ghost'] }], DATA), (e) => {
        assert.equal(e.errorClass, 'table_op_invalid');
        assert.equal(e.opId, 'bad');
        assert.equal(e.field, 'keep[0]');
        assert.equal(e.opStats[1].ok, false);
        assert.equal(e.opStats[1].error.code, 'table_op_invalid');
        assert.equal(e.opStats[1].error.field, 'keep[0]');
        return true;
    });
});

test('an error while the rows flow is pinned to the operation that raised it', async () => {
    const src = table(DATA);
    const ops = [normalizeOp({ id: 'g', op: 'group', by: ['amount'], aggregates: [{ fn: 'count' }] }, 0)];
    const result = await runTableOps({ source: src, ops, runState: {}, limits: { ...LIMITS, maxGroups: 3 }, minGroupFloor: 0, mode: 'run' });
    await assert.rejects(collect(result.rows), (e) => e.errorClass === 'table_too_many_groups' && e.opId === 'g');
    assert.equal(result.opStats[0].ok, false);
});

test('a failing source is not blamed on an operation', async () => {
    const src = { columns: table(DATA).columns, rows: () => (async function* boom() { yield DATA[0]; throw Object.assign(new Error('read failed'), { errorClass: 'table_too_large' }); })() };
    const result = await runTableOps({ source: src, ops: [normalizeOp({ op: 'sample', n: 5 }, 0)], runState: {}, limits: LIMITS, minGroupFloor: 0 });
    await assert.rejects(collect(result.rows), (e) => e.errorClass === 'table_too_large' && e.opId === null);
});

test('the result row cap is table_too_large', async () => {
    await assert.rejects(run([{ op: 'sample', n: 20 }], DATA, { limits: { maxRows: 5 } }), (e) => e.errorClass === 'table_too_large');
});

test('too many operations, and unknown operations, are table_op_invalid', async () => {
    await assert.rejects(run([{ op: 'sample', n: 1 }, { op: 'sample', n: 1 }], DATA, { limits: { maxOps: 1 } }), (e) => e.errorClass === 'table_op_invalid');
    await assert.rejects(run([{ op: 'transmogrify' }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.opId === 'op1');
});

test('warnings are collected with the step number and a code list', async () => {
    const { result } = await run([{ op: 'sample', n: 5 }, { op: 'pseudonymise', columns: ['region'], saltVar: 'S' }], DATA, { mode: 'preview' });
    assert.ok(result.warnings[0].startsWith('Step 2 (pseudonymise):'));
    assert.deepEqual(result.warningCodes, ['preview_salt']);
    assert.equal(result.opStats[1].warnings.length, 1);
});

test('cancellation is checked while rows flow', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i }));
    let checks = 0;
    await assert.rejects(run([{ op: 'filter', rules: [{ column: 'i', test: 'gte', value: 0 }] }], big, { isCancelled: () => ++checks >= 2 }), /cancelled/);
});

test('long streams yield to the event loop so other work keeps running', async () => {
    const big = Array.from({ length: 20000 }, (_, i) => ({ i }));
    let turns = 0;
    let done = false;
    const spinner = (async () => { while (!done) { turns++; await new Promise((r) => setImmediate(r)); } })();
    const { rows } = await run([{ op: 'filter', rules: [{ column: 'i', test: 'gte', value: 0 }] }, { op: 'derive', columns: [{ name: 'x', value: 1 }] }], big);
    done = true;
    await spinner;
    assert.equal(rows.length, 20000);
    assert.ok(turns >= 10, `only ${turns} turns of the event loop`);
});
