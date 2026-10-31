import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDurations } from './merge-durations.mjs';

test('mergeDurations: the union of the shards, longest time wins, sorted by file', () => {
    const merged = mergeDurations([
        { durations: { 'b.test.js': 100, 'a.test.js': 50 } },
        { durations: { 'c.test.js': 7, 'a.test.js': 80 } },
        { durations: { 'd.test.js': Number.NaN } },
    ]);
    assert.deepEqual(Object.keys(merged), ['a.test.js', 'b.test.js', 'c.test.js']);
    assert.equal(merged['a.test.js'], 80);
});
