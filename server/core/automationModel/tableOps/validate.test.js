'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTableStep } = require('./validate');

const SRC = { kind: 'ref', path: 'steps.s1.output.table' };
const step = (ops, extra = {}) => ({ type: 'table', id: 's2', source: SRC, ops, ...extra });
const find = (findings, code) => findings.filter((f) => f.code === `table.${code}`);
const only = (ops, code, path, extra) => {
    const f = find(validateTableStep(step(ops), extra), code);
    assert.equal(f.length, 1, `expected one table.${code}, got ${JSON.stringify(f)}`);
    if (path) assert.equal(f[0].path, path);
    return f[0];
};

test('a good step has no findings', () => {
    const ok = step([
        { op: 'filter', rules: [{ column: 'region', test: 'equals', value: 'north' }] },
        { op: 'group', by: ['region'], aggregates: [{ fn: 'count' }] },
    ]);
    assert.deepEqual(validateTableStep(ok, { columns: [{ key: 'region' }] }), []);
    assert.deepEqual(validateTableStep(step([])), []);
});

test('finding shape: code, severity, path, a sentence naming the step and kind, hint', () => {
    const f = only([{ op: 'group', by: ['a'], aggregates: [] }], 'group_aggregate_invalid', 'ops[0].aggregates');
    assert.equal(f.severity, 'error');
    assert.equal(f.message, 'Step 1 (Group): pick at least one value to calculate.');
    assert.ok(f.hint);
});

test('source, op count, ttl and shape of the step', () => {
    assert.equal(find(validateTableStep({ type: 'table', ops: [] }), 'source_missing')[0].path, 'source');
    assert.equal(find(validateTableStep({ source: { kind: 'ref', path: ' ' }, ops: [] }), 'source_missing').length, 1);
    const many = Array.from({ length: 4 }, () => ({ op: 'sample', n: 1 }));
    assert.equal(find(validateTableStep(step(many), { maxOps: 3 }), 'ops_too_many')[0].path, 'ops');
    assert.equal(find(validateTableStep(step(many)), 'ops_too_many').length, 0);
    assert.equal(find(validateTableStep(step([], { expiresInDays: 91 })), 'expires_invalid')[0].path, 'expiresInDays');
    assert.equal(find(validateTableStep(step('nope')), 'ops_invalid').length, 1);
});

test('operation vocabulary and ids', () => {
    only([{ op: 'frobnicate' }], 'op_unknown', 'ops[0].op');
    const dup = validateTableStep(step([{ id: 'a', op: 'sample', n: 1 }, { id: 'a', op: 'sample', n: 1 }]));
    assert.deepEqual(find(dup, 'op_id_duplicate').map((f) => f.path), ['ops[1].id']);
    only([{ id: 'bad id', op: 'sample', n: 1 }], 'op_id_invalid', 'ops[0].id');
    only([{ op: 'sample', n: 1, note: 'x'.repeat(501) }], 'note_too_long', 'ops[0].note');
});

test('join', () => {
    const base = { op: 'join', with: SRC, on: [{ left: 'a', right: 'b' }] };
    assert.equal(validateTableStep(step([base])).length, 0);
    only([{ ...base, with: null }], 'join_with_missing', 'ops[0].with');
    only([{ ...base, how: 'outer' }], 'join_how_invalid', 'ops[0].how');
    only([{ ...base, onDuplicate: 'some' }], 'join_on_duplicate_invalid');
    only([{ ...base, on: [] }], 'join_on_missing', 'ops[0].on');
    only([{ ...base, on: [{ left: 'a', right: '' }] }], 'join_on_missing', 'ops[0].on[0].right');
    only([{ ...base, on: Array.from({ length: 4 }, () => ({ left: 'a', right: 'b' })) }], 'join_on_too_many', 'ops[0].on');
});

test('pseudonymise', () => {
    const base = { op: 'pseudonymise', columns: ['email'], saltVar: 'SALT_1' };
    assert.equal(validateTableStep(step([base])).length, 0);
    only([{ ...base, columns: [] }], 'pseudonymise_columns_missing', 'ops[0].columns');
    only([{ ...base, columns: Array.from({ length: 11 }, (_, i) => `c${i}`) }], 'pseudonymise_columns_too_many');
    only([{ ...base, saltVar: '1bad' }], 'pseudonymise_salt_var_invalid', 'ops[0].saltVar');
    only([{ ...base, saltVar: '' }], 'pseudonymise_salt_var_invalid');
    only([{ ...base, length: 4 }], 'pseudonymise_length_invalid', 'ops[0].length');
});

test('derive: names, values and formulas', () => {
    const col = (name, value) => ({ name, value });
    only([{ op: 'derive', columns: [] }], 'derive_columns_missing', 'ops[0].columns');
    only([{ op: 'derive', columns: [col('', 1)] }], 'derive_name_invalid', 'ops[0].columns[0].name');
    const dup = validateTableStep(step([{ op: 'derive', columns: [col('A', 1), col('a', 2)] }]));
    assert.deepEqual(find(dup, 'derive_name_invalid').map((f) => f.path), ['ops[0].columns[1].name']);
    only([{ op: 'derive', columns: [col('x', null)] }], 'derive_value_missing', 'ops[0].columns[0].value');
    const bad = only([{ op: 'derive', columns: [col('x', { kind: 'expr', value: 'row.a +' })] }], 'derive_expr_invalid', 'ops[0].columns[0].value');
    assert.match(bad.message, /^Step 1 \(Add columns\): the formula of column 1 cannot be read: /);
    only([{ op: 'derive', columns: [col('x', { kind: 'expr', value: 'nope(row.a)' })] }], 'derive_expr_invalid');
    assert.equal(validateTableStep(step([{ op: 'derive', columns: [col('x', { kind: 'expr', value: 'row.a * 2' })] }])).length, 0);
    only([{ op: 'derive', columns: Array.from({ length: 21 }, (_, i) => col(`c${i}`, 1)) }], 'derive_columns_too_many');
});

test('bucket: bands must be labelled, ordered and not overlap', () => {
    const b = (bands, extra) => ({ op: 'bucket', column: 'score', output: 'band', bands, ...extra });
    assert.equal(validateTableStep(step([b([{ label: 'low', max: 5 }, { label: 'high', min: 5 }])])).length, 0);
    only([b([])], 'bucket_bands_invalid', 'ops[0].bands');
    only([b([{ label: '', max: 5 }])], 'bucket_bands_invalid', 'ops[0].bands[0].label');
    const inverted = only([b([{ label: 'x', min: 9, max: 3 }])], 'bucket_bands_invalid', 'ops[0].bands[0]');
    assert.match(inverted.message, /starts at 9 but ends at 3/);
    const overlap = only([b([{ label: 'a', min: 0, max: 10 }, { label: 'b', min: 5, max: 20 }])], 'bucket_bands_invalid', 'ops[0].bands[1]');
    assert.match(overlap.message, /band 2 overlaps band 1/);
    only([b([{ label: 'a' }, { label: 'b', min: 1 }])], 'bucket_bands_invalid', 'ops[0].bands[1]');
    only([{ op: 'bucket', output: 'b', bands: [{ label: 'a' }] }], 'bucket_column_missing', 'ops[0].column');
    only([{ op: 'bucket', column: 'c', mode: 'quantiles', quantiles: 3, labels: ['a', 'b'] }], 'bucket_labels_invalid', 'ops[0].labels');
    only([{ op: 'bucket', column: 'c', mode: 'values', map: [] }], 'bucket_map_invalid', 'ops[0].map');
    const m = validateTableStep(step([{ op: 'bucket', column: 'c', mode: 'values', map: [{ values: [], label: '' }] }]));
    assert.deepEqual(find(m, 'bucket_map_invalid').map((f) => f.path), ['ops[0].map[0].label', 'ops[0].map[0].values']);
    only([{ op: 'bucket', column: 'c', mode: 'weird' }], 'bucket_mode_invalid');
});

test('group: aggregates, names, sort, by', () => {
    const g = (extra) => ({ op: 'group', by: ['region'], aggregates: [{ fn: 'count' }], ...extra });
    assert.equal(validateTableStep(step([g()])).length, 0);
    only([g({ aggregates: [{ fn: 'sum' }] })], 'group_aggregate_invalid', 'ops[0].aggregates[0].column');
    only([g({ aggregates: [{ fn: 'median', column: 'x' }, { fn: 'blah', column: 'x' }] })], 'group_aggregate_invalid', 'ops[0].aggregates[1].fn');
    only([g({ aggregates: [{ fn: 'count', as: 'n' }] })], 'group_aggregate_invalid', 'ops[0].aggregates[0].as');
    only([g({ aggregates: [{ fn: 'count', as: 'T' }, { fn: 'count', as: 't' }] })], 'group_aggregate_invalid', 'ops[0].aggregates[1].as');
    only([g({ sort: [{ column: 'ghost' }] })], 'group_sort_invalid', 'ops[0].sort[0].column');
    assert.equal(validateTableStep(step([g({ sort: [{ column: 'Count', dir: 'desc' }, { column: 'n' }] })])).length, 0);
    only([g({ by: ['a', 'b', 'c', 'd', 'e', 'f'] })], 'group_by_too_many', 'ops[0].by');
});

test('pivot', () => {
    const p = (extra) => ({ op: 'pivot', rows: 'a', columns: 'b', ...extra });
    assert.equal(validateTableStep(step([p()])).length, 0);
    only([p({ rows: '' })], 'pivot_rows_missing', 'ops[0].rows');
    only([p({ columns: '' })], 'pivot_columns_missing', 'ops[0].columns');
    only([p({ columns: 'a' })], 'pivot_same_column', 'ops[0].columns');
    only([p({ value: { fn: 'sum' } })], 'pivot_value_invalid', 'ops[0].value.column');
    only([p({ percent: 'half' })], 'pivot_percent_invalid', 'ops[0].percent');
    const w = only([p({ percent: 'row', value: { fn: 'mean', column: 'x' } })], 'pivot_percent_mean', 'ops[0].percent');
    assert.equal(w.severity, 'warning');
});

test('filter: rules, formula and the empty-filter warning', () => {
    const rule = { column: 'a', test: 'equals', value: 1 };
    assert.equal(validateTableStep(step([{ op: 'filter', rules: [rule] }])).length, 0);
    assert.equal(validateTableStep(step([{ op: 'filter', rulesFrom: { kind: 'ref', path: 'item.rules' } }])).length, 0);
    only([{ op: 'filter', rules: [rule, { column: 'a', test: 'nope', value: 1 }] }], 'filter_rule_invalid', 'ops[0].rules[1].test');
    only([{ op: 'filter', rules: [{ test: 'equals', value: 1 }] }], 'filter_rule_invalid', 'ops[0].rules[0].column');
    only([{ op: 'filter', rules: [{ column: 'a', test: 'between', value: [1] }] }], 'filter_rule_invalid', 'ops[0].rules[0].value');
    const expr = only([{ op: 'filter', expr: 'row.a ==' }], 'filter_expr_invalid', 'ops[0].expr');
    assert.match(expr.message, /^Step 1 \(Filter\): /);
    const empty = only([{ op: 'filter' }], 'filter_empty', 'ops[0]');
    assert.equal(empty.severity, 'warning');
    only([{ op: 'filter', match: 'some', rules: [rule] }], 'filter_match_invalid');
    assert.equal(validateTableStep(step([{ op: 'filter', rules: [{ column: 'a', test: 'equals', value: { kind: 'ref', path: 'vars.x' } }] }])).length, 0);
});

test('select', () => {
    only([{ op: 'select', keep: ['a'], drop: ['b'] }], 'select_conflict', 'ops[0]');
    only([{ op: 'select', rename: [{ from: 'a', to: '' }] }], 'select_rename_invalid', 'ops[0].rename[0]');
    only([{ op: 'select', rename: [{ from: 'a', to: 'z' }, { from: 'b', to: 'Z' }] }], 'select_rename_invalid', 'ops[0].rename');
    assert.equal(only([{ op: 'select' }], 'select_empty').severity, 'warning');
});

test('sample needs exactly one valid size', () => {
    assert.equal(validateTableStep(step([{ op: 'sample', n: 5 }])).length, 0);
    assert.equal(validateTableStep(step([{ op: 'sample', percent: 10, mode: 'random' }])).length, 0);
    only([{ op: 'sample' }], 'sample_size_invalid', 'ops[0].n');
    only([{ op: 'sample', n: 5, percent: 10 }], 'sample_size_invalid', 'ops[0].percent');
    only([{ op: 'sample', n: 0 }], 'sample_size_invalid', 'ops[0].n');
    only([{ op: 'sample', percent: 101 }], 'sample_size_invalid', 'ops[0].percent');
    only([{ op: 'sample', n: 2, mode: 'sorted' }], 'sample_mode_invalid');
});

test('groups: splits, the low-minimum warning and operations after it', () => {
    const g = (extra) => ({ op: 'groups', splits: [{ column: 'a' }], minN: 30, ...extra });
    assert.equal(validateTableStep(step([g()])).length, 0);
    only([g({ splits: [] })], 'groups_splits_missing', 'ops[0].splits');
    only([g({ splits: [{ column: '' }] })], 'groups_column_missing', 'ops[0].splits[0].column');
    only([g({ splits: Array.from({ length: 11 }, () => ({ column: 'a' })) })], 'groups_splits_too_many');
    const low = only([g({ minN: 5 })], 'groups_min_n_low', 'ops[0].minN');
    assert.equal(low.severity, 'warning');
    const after = find(validateTableStep(step([g(), { op: 'filter', expr: 'row.n > 1' }, { enabled: false, op: 'sample', n: 1 }])), 'ops_after_groups');
    assert.deepEqual(after.map((f) => [f.path, f.severity]), [['ops[1]', 'warning']]);
});

test('describe checks its column list', () => {
    assert.equal(validateTableStep(step([{ op: 'describe' }])).length, 0);
    only([{ op: 'describe', columns: 'a' }], 'describe_columns_invalid', 'ops[0].columns');
});

test('known input columns add column_missing findings; messages never contain cell values', () => {
    const f = validateTableStep(step([{ op: 'group', by: ['ghost'], aggregates: [{ fn: 'count' }] }]), { columns: [{ key: 'region' }] });
    assert.deepEqual(f.map((x) => [x.code, x.path]), [['table.column_missing', 'ops[0].by[0]']]);
});
