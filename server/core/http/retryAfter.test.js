'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter, backoffDelay, sleep } = require('./retryAfter');

test('Retry-After: seconds or an HTTP date, as milliseconds from now', () => {
    assert.equal(parseRetryAfter('7'), 7000);
    assert.equal(parseRetryAfter('0'), 0);
    const now = Date.parse('2026-10-06T10:00:00Z');
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 10:00:05 GMT', now), 5000);
    // A date in the past means "now", never a negative wait.
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 09:00:00 GMT', now), 0);
    for (const missing of [null, undefined, '', 'soon']) assert.equal(parseRetryAfter(missing), null);
});

test('backoff: the server\'s Retry-After wins, else doubling with jitter, always clamped', () => {
    const noJitter = { random: () => 0 };
    assert.equal(backoffDelay(0, noJitter), 500);
    assert.equal(backoffDelay(1, noJitter), 1000);
    assert.equal(backoffDelay(3, noJitter), 4000);
    assert.equal(backoffDelay(2, { random: () => 0.5, jitterMs: 200 }), 2100);
    assert.equal(backoffDelay(0, { retryAfterMs: 12_000 }), 12_000);
    // A hostile or broken server cannot park the worker for a day.
    assert.equal(backoffDelay(0, { retryAfterMs: 86_400_000 }), 30_000);
    assert.equal(backoffDelay(20, { ...noJitter, maxMs: 8000 }), 8000);
});

test('sleep ends early when the signal aborts', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const waiting = sleep(10_000, ac.signal);
    ac.abort();
    await waiting;
    assert.ok(Date.now() - started < 1000);
    await sleep(0);
});
