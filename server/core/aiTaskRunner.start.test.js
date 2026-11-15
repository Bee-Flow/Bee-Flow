// @typecheck strict
/**
 * The hourly coverage prune runs once boot calls start(), not because the
 * runner was required. memoryStore is the real module with its prune replaced
 * per test.
 *
 * Run: node --test core/aiTaskRunner.start.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useMockedTimers } = require('../testUtils/mockedTimers');

// Before the runner loads: a timer it armed at require time would fire in the first test.
const timers = useMockedTimers();
const memoryStore = require('../stores/memoryStore');
const runner = require('./aiTaskRunner');

const HOUR_MS = 60 * 60_000;

/**
 * Count the prunes of one test, and stop the runner when the test ends.
 * @param {import('node:test').TestContext} t
 */
function countPrunes(t) {
    const prune = t.mock.method(memoryStore, 'pruneExpiredCoverage', async () => 0);
    t.after(() => runner.stop());
    return () => prune.mock.callCount();
}

test('requiring the runner arms no prune', async (t) => {
    const prunes = countPrunes(t);
    await timers.advance(3 * HOUR_MS);
    assert.equal(prunes(), 0);
});

test('start() prunes the expired coverage every hour', async (t) => {
    const prunes = countPrunes(t);
    assert.equal(runner.start(), true);

    await timers.advance(HOUR_MS - 1);
    assert.equal(prunes(), 0);

    await timers.advance(1);
    assert.equal(prunes(), 1);

    await timers.advance(HOUR_MS);
    assert.equal(prunes(), 2);
});

test('start() is idempotent, stop() calls the prune off, and start() arms it again', async (t) => {
    const prunes = countPrunes(t);
    assert.equal(runner.start(), true);
    assert.equal(runner.start(), false);
    await timers.advance(HOUR_MS);
    assert.equal(prunes(), 1, 'one prune per hour, not one per call');

    runner.stop();
    await timers.advance(3 * HOUR_MS);
    assert.equal(prunes(), 1);

    assert.equal(runner.start(), true);
    await timers.advance(HOUR_MS);
    assert.equal(prunes(), 2);
});
