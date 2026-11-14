'use strict';
const test = require('node:test');
const assert = require('node:assert');
const log = require('../telemetry/log');
const { bestEffort, fallback, ignoreGone, isGone, bestEffortCounts, resetBestEffort, LOG_INTERVAL_MS } = require('./bestEffort');

function capture(t) {
    const calls = [];
    t.mock.method(log, 'warn', (...args) => { calls.push(args); });
    return calls;
}

test('bestEffort: counts per label and logs one warn', (t) => {
    resetBestEffort();
    const calls = capture(t);
    assert.strictEqual(bestEffort('mail/send:welcome', new Error('smtp down')), undefined);
    assert.deepStrictEqual(bestEffortCounts(), { 'mail/send:welcome': { count: 1, kind: 'best-effort' } });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0][0], /^\[best-effort\] mail\/send:welcome failed, carrying on$/);
    assert.ok(calls[0][1] instanceof Error);
});

test('bestEffort: rate-limited per label, the rest counted and reported on the next warn', (t) => {
    resetBestEffort();
    const calls = capture(t);
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 5; i++) bestEffort('a:x', new Error('boom'));
    bestEffort('b:y', new Error('boom'));
    assert.strictEqual(calls.length, 2, 'one warn per label inside the interval');
    assert.strictEqual(bestEffortCounts()['a:x'].count, 5);
    now += LOG_INTERVAL_MS;
    bestEffort('a:x', new Error('boom'));
    assert.strictEqual(calls.length, 3);
    assert.match(calls[2][0], /a:x failed, carrying on \(\+4 more in the last minute\)/);
});

test('fallback: returns the value and warns once', (t) => {
    resetBestEffort();
    const calls = capture(t);
    const fallbackValue = [];
    assert.strictEqual(fallback('reports/list:load', new Error('x'), fallbackValue), fallbackValue);
    assert.strictEqual(fallback('reports/list:load', new Error('x')), undefined);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0][0], /^\[fallback\] reports\/list:load fell back to a default$/);
    assert.strictEqual(bestEffortCounts()['reports/list:load'].count, 2);
});

test('the log line carries the label only, never the error text', (t) => {
    resetBestEffort();
    const calls = capture(t);
    bestEffort('x:y', new Error('jane@example.com said hello'));
    assert.ok(!calls[0][0].includes('jane@example.com'));
});

test('works as a promise catch handler', async (t) => {
    resetBestEffort();
    capture(t);
    assert.strictEqual(await Promise.reject(new Error('x')).catch((e) => bestEffort('p:q', e)), undefined);
    assert.strictEqual(await Promise.reject(new Error('x')).catch((e) => fallback('p:r', e, null)), null);
});

const coded = (code) => Object.assign(new Error('x'), { code });

test('ignoreGone: an already-gone target leaves no trace', (t) => {
    resetBestEffort();
    const calls = capture(t);
    ignoreGone('tmp:unlink', coded('ENOENT'));
    ignoreGone('sock:end', coded('ERR_STREAM_DESTROYED'));
    ignoreGone('abort', Object.assign(new Error('x'), { name: 'AbortError' }));
    const fs = require('node:fs');
    try { fs.unlinkSync(require('node:path').join(require('node:os').tmpdir(), `bf-gone-${process.pid}-${Date.now()}`)); } catch (e) { ignoreGone('tmp:real', e); }
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(bestEffortCounts(), {});
});

test('ignoreGone: any other failure is reported through bestEffort', (t) => {
    resetBestEffort();
    const calls = capture(t);
    assert.strictEqual(ignoreGone('tmp:unlink', coded('EACCES')), undefined);
    ignoreGone('docker:stop', Object.assign(new Error('x'), { statusCode: 500 }), [304, 404]);
    ignoreGone('odd', 'a string');
    assert.strictEqual(calls.length, 3);
    assert.match(calls[0][0], /^\[best-effort\] tmp:unlink failed, carrying on$/);
    assert.strictEqual(bestEffortCounts()['docker:stop'].count, 1);
});

test('isGone: extra codes, names and status codes per call site', () => {
    assert.strictEqual(isGone(Object.assign(new Error('x'), { statusCode: 304 })), false);
    assert.strictEqual(isGone(Object.assign(new Error('x'), { statusCode: 304 }), [304, 404]), true);
    assert.strictEqual(isGone(Object.assign(new Error('x'), { name: 'TargetClosedError' }), ['TargetClosedError']), true);
    assert.strictEqual(isGone(coded('EBUSY'), ['ENOTEMPTY']), false);
    assert.strictEqual(isGone(null), false);
    assert.strictEqual(isGone(undefined), false);
});
