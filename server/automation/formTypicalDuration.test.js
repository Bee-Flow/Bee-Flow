'use strict';

/**
 * automation/formTypicalDuration.js: the median of recent leg durations as the
 * one aggregate the public form poll may show. Needs 3 samples, is cached for
 * five minutes, bounded, and never throws.
 *
 * Run: cd server && node --test automation/formTypicalDuration.test.js
 */

const { test, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert');

const { typicalSeconds: typicalSecondsWith, _resetForTests } = require('./formTypicalDuration');

// The reader is injected: no store, no module patching.
const stub = { calls: [], samples: {}, fail: false };
const read = async (id, opts) => {
    stub.calls.push({ id, opts });
    if (stub.fail) throw new Error('db down');
    return stub.samples[id] || [];
};
const typicalSeconds = (id) => typicalSecondsWith(id, { read });

beforeEach(() => {
    _resetForTests();
    stub.calls = [];
    stub.samples = {};
    stub.fail = false;
});
after(() => { mock.timers.reset(); });

test('the median of an odd number of samples, in whole seconds', async () => {
    stub.samples.a = [9000, 1000, 4000];
    assert.strictEqual(await typicalSeconds('a'), 4);
    assert.deepStrictEqual(stub.calls[0], { id: 'a', opts: { limit: 20 } });
});

test('an even count takes the mean of the middle two, rounded', async () => {
    stub.samples.a = [1000, 2000, 3000, 8000];
    assert.strictEqual(await typicalSeconds('a'), 3);
});

test('never below one second', async () => {
    stub.samples.a = [10, 20, 30];
    assert.strictEqual(await typicalSeconds('a'), 1);
});

test('fewer than three samples is no figure', async () => {
    stub.samples.a = [1000, 2000];
    assert.strictEqual(await typicalSeconds('a'), null);
    assert.strictEqual(await typicalSeconds(''), null);
    assert.strictEqual(await typicalSeconds(undefined), null);
});

test('a second ask inside five minutes is answered from the cache, then it expires', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    stub.samples.a = [1000, 2000, 3000];
    assert.strictEqual(await typicalSeconds('a'), 2);
    stub.samples.a = [10000, 10000, 10000];
    mock.timers.setTime(1_000_000 + 4 * 60 * 1000);
    assert.strictEqual(await typicalSeconds('a'), 2);
    assert.strictEqual(stub.calls.length, 1);
    mock.timers.setTime(1_000_000 + 5 * 60 * 1000 + 1);
    assert.strictEqual(await typicalSeconds('a'), 10);
    assert.strictEqual(stub.calls.length, 2);
    mock.timers.reset();
});

test('a "no figure" answer is cached too, so a quiet automation is not queried every poll', async () => {
    assert.strictEqual(await typicalSeconds('a'), null);
    assert.strictEqual(await typicalSeconds('a'), null);
    assert.strictEqual(stub.calls.length, 1);
});

test('a store failure is null and never throws', async () => {
    stub.fail = true;
    assert.strictEqual(await typicalSeconds('a'), null);
});

test('the cache is bounded: the oldest entry is evicted past 1000', async () => {
    stub.samples.first = [1000, 1000, 1000];
    await typicalSeconds('first');
    for (let i = 0; i < 1000; i++) await typicalSeconds(`id${i}`);
    stub.calls = [];
    await typicalSeconds('first');
    assert.strictEqual(stub.calls.length, 1, 'the first entry was evicted and is read again');
    stub.calls = [];
    await typicalSeconds('id999');
    assert.strictEqual(stub.calls.length, 0, 'a recent entry is still cached');
});
