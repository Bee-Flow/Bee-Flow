'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spec = require('./spec');
const { TABLE_OPS, normalizeTableStep, normalizeOp } = spec;

test('the vocabulary and the lazily exposed validator and planner are on spec', () => {
    assert.deepEqual(TABLE_OPS, ['join', 'pseudonymise', 'derive', 'bucket', 'group', 'pivot', 'filter', 'select', 'sample', 'groups', 'describe']);
    assert.equal(typeof spec.validateTableStep, 'function');
    assert.equal(typeof spec.planColumns, 'function');
    assert.equal(typeof spec.normalizeRules, 'function');
});

test('a step gets its defaults: ttl, no name, empty ops', () => {
    assert.deepEqual(normalizeTableStep({ type: 'table' }), { source: null, ops: [], name: null, expiresInDays: 7 });
    assert.equal(normalizeTableStep({ expiresInDays: 500 }).expiresInDays, 90);
    assert.equal(normalizeTableStep({ expiresInDays: 0 }).expiresInDays, 1);
    assert.equal(normalizeTableStep({ expiresInDays: 'x' }).expiresInDays, 7);
    assert.equal(normalizeTableStep({ name: '  Totals ' }).name, 'Totals');
    assert.equal(normalizeTableStep(null).ops.length, 0);
});

test('op ids default to op<position>, bad ones are replaced, enabled defaults true, notes are cut', () => {
    const step = normalizeTableStep({ ops: [{ op: 'sample', n: 1 }, { id: 'keep_me-2', op: 'sample', n: 1 }, { id: 'no good!', op: 'sample', n: 1, enabled: false, note: 'x'.repeat(600) }] });
    assert.deepEqual(step.ops.map((o) => o.id), ['op1', 'keep_me-2', 'op3']);
    assert.deepEqual(step.ops.map((o) => o.enabled), [true, true, false]);
    assert.equal(step.ops[2].note.length, 500);
    assert.equal(step.ops[0].note, undefined);
});

test('an unknown operation is kept by name and marked', () => {
    assert.deepEqual(normalizeOp({ op: 'frobnicate' }, 3), { id: 'op4', op: 'frobnicate', enabled: true, unknown: true });
    assert.equal(normalizeOp(null, 0).unknown, true);
});

test('join defaults', () => {
    const j = normalizeOp({ op: 'join', with: { kind: 'ref', path: 'x' }, on: [{ left: ' a ', right: 'b', alternatives: ['c', ' '] }] }, 0);
    assert.deepEqual(j, {
        id: 'op1', op: 'join', enabled: true, with: { kind: 'ref', path: 'x' }, how: 'left',
        on: [{ left: 'a', right: 'b', alternatives: ['c'] }], caseInsensitive: true, trim: true, columns: null, prefix: '', onDuplicate: 'first',
    });
    assert.equal(normalizeOp({ op: 'join', how: 'outer', onDuplicate: 'all', caseInsensitive: false }, 0).how, 'left');
});

test('pseudonymise defaults and clamps', () => {
    const p = normalizeOp({ op: 'pseudonymise', columns: ['a'], saltVar: 'S' }, 0);
    assert.deepEqual([p.output, p.length, p.keepColumns, p.dropColumns], ['pseudonym', 16, false, []]);
    assert.equal(normalizeOp({ op: 'pseudonymise', length: 3 }, 0).length, 8);
    assert.equal(normalizeOp({ op: 'pseudonymise', length: 500 }, 0).length, 64);
});

test('bucket defaults', () => {
    const b = normalizeOp({ op: 'bucket', column: 'score', bands: [{ label: 'a', min: '1,5', max: null }] }, 0);
    assert.deepEqual([b.mode, b.quantiles, b.labels, b.otherLabel, b.output], ['bands', 4, null, 'Other', 'score (group)']);
    assert.deepEqual(b.bands, [{ label: 'a', min: 1.5, max: null }]);
    assert.equal(normalizeOp({ op: 'bucket', otherLabel: '' }, 0).otherLabel, null);
    assert.equal(normalizeOp({ op: 'bucket', quantiles: 99 }, 0).quantiles, 20);
});

test('group defaults: aggregate names, sort direction, minN', () => {
    const g = normalizeOp({ op: 'group', aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'amount' }, { fn: 'share' }, { fn: 'mean', column: 'x', as: 'avg' }], sort: [{ column: 'n', dir: 'desc' }, { column: 'a', dir: 'weird' }] }, 0);
    assert.deepEqual(g.aggregates.map((a) => a.as), ['Count', 'Sum of amount', 'Share (%)', 'avg']);
    assert.deepEqual(g.sort.map((s) => s.dir), ['desc', 'asc']);
    assert.deepEqual([g.minN, g.weight, g.by], [0, null, []]);
});

test('pivot defaults', () => {
    const p = normalizeOp({ op: 'pivot', rows: 'a', columns: 'b' }, 0);
    assert.deepEqual(p, { id: 'op1', op: 'pivot', enabled: true, rows: 'a', columns: 'b', value: { fn: 'count' }, weight: null, percent: 'none', totals: true, minN: 0, decimals: 1, columnOrder: null, missingLabel: '(empty)' });
});

test('filter, select, sample, groups, describe defaults', () => {
    assert.deepEqual(normalizeOp({ op: 'filter' }, 0), { id: 'op1', op: 'filter', enabled: true, match: 'all', rules: [], rulesFrom: null, rulesFromMatch: 'all', expr: null });
    assert.deepEqual(normalizeOp({ op: 'select', keep: ['a'] }, 0), { id: 'op1', op: 'select', enabled: true, keep: ['a'], drop: null, rename: [] });
    const s = normalizeOp({ op: 'sample', n: 5.9 }, 0);
    assert.deepEqual([s.mode, s.n, s.percent, s.seed], ['first', 5, null, 'sample']);
    assert.equal(normalizeOp({ op: 'sample', percent: 150 }, 0).percent, null);
    const g = normalizeOp({ op: 'groups', splits: [{ column: 'a', values: ['x'], separator: ';', label: 'A' }, { column: 'b' }] }, 0);
    assert.deepEqual([g.includeTotal, g.totalLabel, g.minN], [true, 'All', 30]);
    assert.deepEqual(g.splits[1], { column: 'b', values: null, separator: null, label: null });
    const d = normalizeOp({ op: 'describe' }, 0);
    assert.deepEqual([d.columns, d.maxOptions, d.separator, d.sampleValues], [null, 50, null, 5]);
    assert.equal(normalizeOp({ op: 'describe', maxOptions: 1, sampleValues: 99 }, 0).maxOptions, 2);
});

test('derive keeps bindings as typed', () => {
    const d = normalizeOp({ op: 'derive', columns: [{ name: ' x ', value: { kind: 'expr', value: '1' } }, { value: 3 }] }, 0);
    assert.deepEqual(d.columns, [{ name: 'x', value: { kind: 'expr', value: '1' } }, { name: '', value: 3 }]);
});
