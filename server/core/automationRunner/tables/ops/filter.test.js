'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [
    { region: 'North', score: '7,5', tags: 'a;b' },
    { region: 'south ', score: '3', tags: 'b' },
    { region: 'East', score: '', tags: '' },
    { region: 'north', score: '9', tags: 'c' },
];

test('filter keeps rows that pass every rule (match all)', async () => {
    const { rows } = await run([{ op: 'filter', rules: [{ column: 'region', test: 'equals', value: 'NORTH' }, { column: 'score', test: 'gt', value: 8 }] }], DATA);
    assert.deepEqual(rows.map((r) => r.score), ['9']);
});

test('filter match any, with a decimal comma read as a number', async () => {
    const { rows } = await run([{ op: 'filter', match: 'any', rules: [{ column: 'score', test: 'between', value: [7, 8] }, { column: 'region', test: 'starts_with', value: 'EA' }] }], DATA);
    assert.deepEqual(rows.map((r) => r.region), ['North', 'East']);
});

test('filter contains_item looks inside a multi-answer cell', async () => {
    const { rows } = await run([{ op: 'filter', rules: [{ column: 'tags', test: 'contains_item', value: 'B' }] }], DATA);
    assert.equal(rows.length, 2);
});

test('filter rule values may be bindings', async () => {
    const { rows } = await run([{ op: 'filter', rules: [{ column: 'region', test: 'equals', value: { kind: 'ref', path: 'vars.wanted' } }] }], DATA, { runState: { vars: { wanted: 'south' } } });
    assert.equal(rows.length, 1);
});

test('filter expr uses the restricted formula language on row', async () => {
    const { rows } = await run([{ op: 'filter', expr: 'row.region == "East" || row.score == "9"' }], DATA);
    assert.deepEqual(rows.map((r) => r.region), ['East', 'north']);
});

test('filter expr that cannot be read is table_op_invalid on the expr field', async () => {
    await assert.rejects(run([{ op: 'filter', expr: 'unknownFn(row.region)' }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.field === 'expr' && e.opId === 'op1');
});

test('filter rulesFrom is applied at run time (match all) and an empty list keeps every row', async () => {
    const fed = [{ column: 'region', test: 'equals', value: 'north' }];
    const state = { vars: {}, steps: { s: { output: { rules: fed, none: [] } } } };
    const a = await run([{ op: 'filter', rulesFrom: { kind: 'ref', path: 'steps.s.output.rules' } }], DATA, { runState: state });
    assert.equal(a.rows.length, 2);
    const b = await run([{ op: 'filter', rulesFrom: { kind: 'ref', path: 'steps.s.output.none' } }], DATA, { runState: state });
    assert.equal(b.rows.length, 4);
});

test('filter rulesFrom with an unknown test or column is table_rule_invalid naming the rule', async () => {
    const mk = (rules) => ({ vars: {}, steps: { s: { output: { rules } } } });
    const op = [{ op: 'filter', rulesFrom: { kind: 'ref', path: 'steps.s.output.rules' } }];
    await assert.rejects(run(op, DATA, { runState: mk([{ column: 'region', test: 'equals', value: 'x' }, { column: 'region', test: 'resembles', value: 'x' }]) }),
        (e) => e.errorClass === 'table_rule_invalid' && /Rule from earlier step 2/.test(e.message) && e.field === 'rulesFrom[1]');
    await assert.rejects(run(op, DATA, { runState: mk([{ column: 'ghost', test: 'equals', value: 'x' }]) }),
        (e) => e.errorClass === 'table_rule_invalid' && /ghost/.test(e.message));
    await assert.rejects(run(op, DATA, { runState: mk(undefined) }), (e) => e.errorClass === 'table_rule_invalid');
});

test('filter rulesFrom is skipped in preview with a warning code', async () => {
    const { rows, result } = await run([{ op: 'filter', rulesFrom: { kind: 'ref', path: 'steps.s.output.rules' } }], DATA, { mode: 'preview' });
    assert.equal(rows.length, 4);
    assert.ok(result.warningCodes.includes('rules_from_runtime'));
});

test('filter with a bad own rule fails before any row flows', async () => {
    await assert.rejects(run([{ op: 'filter', rules: [{ column: 'region', test: 'nope', value: 1 }] }], DATA), (e) => e.errorClass === 'table_rule_invalid');
});
