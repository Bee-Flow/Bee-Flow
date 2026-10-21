'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const DATA = [{ score: 1 }, { score: '5,5' }, { score: 10 }, { score: 25 }, { score: '' }, { score: 'n/a' }];
const labels = (rows, key = 'band') => rows.map((r) => r[key]);

test('bucket bands: lowest included, highest excluded, open ends, other label', async () => {
    const { rows, keys } = await run([{ op: 'bucket', column: 'score', output: 'band', bands: [
        { label: 'low', max: 5.5 }, { label: 'mid', min: 5.5, max: 10 }, { label: 'high', min: 10, max: 20 },
    ] }], DATA);
    assert.deepEqual(keys, ['score', 'band']);
    assert.deepEqual(labels(rows), ['low', 'mid', 'high', 'Other', null, 'Other']);
});

test('bucket bands with otherLabel null leaves unmatched values empty', async () => {
    const { rows } = await run([{ op: 'bucket', column: 'score', output: 'band', otherLabel: null, bands: [{ label: 'low', max: 5 }] }], DATA);
    assert.deepEqual(labels(rows), ['low', null, null, null, null, null]);
});

test('bucket quantiles splits into equal parts with default and custom labels', async () => {
    const data = Array.from({ length: 8 }, (_, i) => ({ score: i + 1 }));
    const a = await run([{ op: 'bucket', column: 'score', output: 'q', mode: 'quantiles', quantiles: 4 }], data);
    assert.deepEqual(labels(a.rows, 'q'), ['Q1', 'Q1', 'Q2', 'Q2', 'Q3', 'Q3', 'Q4', 'Q4']);
    const b = await run([{ op: 'bucket', column: 'score', output: 'q', mode: 'quantiles', quantiles: 2, labels: ['lower', 'upper'] }], data);
    assert.deepEqual(labels(b.rows, 'q'), ['lower', 'lower', 'lower', 'lower', 'upper', 'upper', 'upper', 'upper']);
    await assert.rejects(run([{ op: 'bucket', column: 'score', output: 'q', mode: 'quantiles', quantiles: 3, labels: ['a'] }], data), (e) => e.errorClass === 'table_op_invalid');
});

test('bucket values maps listed values, text ignoring case, numbers as numbers', async () => {
    const data = [{ c: 'Red' }, { c: 'blue ' }, { c: 'green' }, { c: 3 }, { c: '3.0' }, { c: null }];
    const { rows } = await run([{ op: 'bucket', column: 'c', output: 'g', mode: 'values', map: [
        { values: ['red', 'blue'], label: 'cool-ish' }, { values: [3], label: 'three' },
    ] }], data);
    assert.deepEqual(labels(rows, 'g'), ['cool-ish', 'cool-ish', 'Other', 'three', 'three', null]);
});

test('bucket replaces an existing output column in place and needs a known column', async () => {
    const { keys } = await run([{ op: 'bucket', column: 'score', output: 'score', bands: [{ label: 'x' }] }], DATA);
    assert.deepEqual(keys, ['score']);
    await assert.rejects(run([{ op: 'bucket', column: 'nope', output: 'b', bands: [{ label: 'x' }] }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.field === 'column');
});
