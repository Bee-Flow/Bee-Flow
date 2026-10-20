'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planColumns } = require('./planColumns');
const { normalizeOp } = require('./spec');

const IN = [{ key: 'region', label: 'region', type: 'text' }, { key: 'amount', label: 'amount', type: 'number' }, { key: 'email', label: 'email', type: 'text' }];
const plan = (ops, columns = IN) => planColumns(columns, ops.map((o, i) => normalizeOp(o, i)));
const keys = (r) => r.columns.map((c) => c.key);

test('no operations keeps the columns', () => {
    assert.deepEqual(keys(plan([])), ['region', 'amount', 'email']);
});

test('select keep, drop and rename', () => {
    assert.deepEqual(keys(plan([{ op: 'select', keep: ['amount', 'region'] }])), ['amount', 'region']);
    assert.deepEqual(keys(plan([{ op: 'select', drop: ['EMAIL'] }])), ['region', 'amount']);
    const r = plan([{ op: 'select', rename: [{ from: 'amount', to: 'total' }] }]);
    assert.deepEqual(r.columns.map((c) => [c.key, c.label]), [['region', 'region'], ['total', 'total'], ['email', 'email']]);
});

test('derive adds or replaces; bucket adds its output; pseudonymise swaps columns', () => {
    assert.deepEqual(keys(plan([{ op: 'derive', columns: [{ name: 'x', value: 1 }, { name: 'amount', value: 2 }] }])), ['region', 'amount', 'email', 'x']);
    assert.deepEqual(keys(plan([{ op: 'bucket', column: 'amount', output: 'band', bands: [{ label: 'a' }] }])), ['region', 'amount', 'email', 'band']);
    assert.deepEqual(keys(plan([{ op: 'pseudonymise', columns: ['email'], saltVar: 'S' }])), ['region', 'amount', 'pseudonym']);
    assert.deepEqual(keys(plan([{ op: 'pseudonymise', columns: ['email'], saltVar: 'S', keepColumns: true, dropColumns: ['region'], output: 'code' }])), ['amount', 'email', 'code']);
});

test('group gives by, aggregates, n and suppressed (the organisation floor applies to every group)', () => {
    const ops = [{ op: 'group', by: ['region'], aggregates: [{ fn: 'sum', column: 'amount', as: 'total' }, { fn: 'max', column: 'amount', as: 'top' }] }];
    const r = plan(ops);
    assert.deepEqual(keys(r), ['region', 'total', 'top', 'n', 'suppressed']);
    assert.deepEqual(r.columns.map((c) => c.type), ['text', 'number', 'mixed', 'number', 'boolean']);
    assert.deepEqual(keys(plan([{ ...ops[0], minN: 5 }])), ['region', 'total', 'top', 'n', 'suppressed']);
});

test('groups gives the fixed segment table', () => {
    assert.deepEqual(keys(plan([{ op: 'groups', splits: [{ column: 'region' }] }])), ['segment', 'label', 'column', 'value', 'n', 'suppressed']);
});

test('pivot and a join that takes every column make the result data-dependent', () => {
    assert.equal(plan([{ op: 'pivot', rows: 'region', columns: 'amount' }]).columns, null);
    assert.equal(plan([{ op: 'join', with: {}, on: [{ left: 'region', right: 'x' }] }]).columns, null);
    assert.deepEqual(keys(plan([{ op: 'join', with: {}, on: [{ left: 'region', right: 'x' }], columns: ['owner', 'region'], prefix: 'o_' }])), ['region', 'amount', 'email', 'o_owner', 'o_region']);
});

test('later operations are not checked once the columns are unknown, and unknown input skips checks', () => {
    const r = plan([{ op: 'pivot', rows: 'region', columns: 'amount' }, { op: 'select', keep: ['whatever'] }]);
    assert.equal(r.columns, null);
    assert.deepEqual(r.findings, []);
    assert.equal(planColumns(null, [normalizeOp({ op: 'select', keep: ['q'] }, 0)]).findings.length, 0);
});

test('an unknown column is a finding with the step number, path and the available columns', () => {
    const r = plan([{ op: 'select', keep: ['region', 'ghost'] }, { op: 'filter', rules: [{ column: 'region', test: 'equals', value: 1 }] }]);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0], {
        code: 'table.column_missing', severity: 'error', path: 'ops[0].keep[1]',
        message: 'Step 1 (Select columns): the column "ghost" is not in the table at this point.',
        hint: 'Available columns: region, amount, email.',
    });
});

test('a column dropped earlier is missing later; disabled and unknown operations are ignored', () => {
    const r = plan([{ op: 'select', drop: ['email'] }, { op: 'group', by: ['email'], aggregates: [{ fn: 'count' }] }, { enabled: false, op: 'select', keep: ['zzz'] }, { op: 'nonsense' }]);
    assert.deepEqual(r.findings.map((f) => f.path), ['ops[1].by[0]']);
});

test('join key alternatives are accepted', () => {
    const r = plan([{ op: 'join', with: {}, on: [{ left: 'identifier', right: 'k', alternatives: ['Region'] }], columns: ['v'] }]);
    assert.deepEqual(r.findings, []);
});
