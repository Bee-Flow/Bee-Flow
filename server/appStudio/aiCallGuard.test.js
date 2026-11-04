'use strict';

/** Run: cd server && node --test appStudio/aiCallGuard.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { guardedAiCall, aiCallTimeoutMs, DEFAULT_AI_CALL_TIMEOUT_MS } = require('./aiCallGuard.mts');

const logs = () => { const lines = []; return { lines, log: { info: (...a) => lines.push(a.join(' ')) } }; };
const INFO = { kind: 'text', model: 'm-1' };

test('timeout value: default, 0 = off, junk and negatives fall back to the default', () => {
    assert.equal(aiCallTimeoutMs({}), DEFAULT_AI_CALL_TIMEOUT_MS);
    assert.equal(aiCallTimeoutMs({ STUDIO_AI_CALL_TIMEOUT_MS: '' }), 120_000);
    assert.equal(aiCallTimeoutMs({ STUDIO_AI_CALL_TIMEOUT_MS: '0' }), 0);
    assert.equal(aiCallTimeoutMs({ STUDIO_AI_CALL_TIMEOUT_MS: '50' }), 50);
    assert.equal(aiCallTimeoutMs({ STUDIO_AI_CALL_TIMEOUT_MS: 'abc' }), 120_000);
    assert.equal(aiCallTimeoutMs({ STUDIO_AI_CALL_TIMEOUT_MS: '-5' }), 120_000);
});

test('a provider that never answers: aborted, one retry, then the safe step error', async () => {
    const { lines, log } = logs();
    const signals = [];
    // Ignores the signal on purpose: the deadline must still win.
    const call = (signal) => { signals.push(signal); return new Promise(() => {}); };
    await assert.rejects(
        guardedAiCall(call, INFO, { log, env: { STUDIO_AI_CALL_TIMEOUT_MS: '50' } }),
        (e) => e.status === 504 && e.code === 'ai_timeout' && e.safe === true && /^The AI gave no answer within \d+ s$/.test(e.message),
    );
    assert.equal(signals.length, 2, 'exactly one retry');
    assert.ok(signals.every((s) => s.aborted), 'every request signal fired');
    assert.match(lines[0], /^\[AppAI\] text m-1 timed out after \d+ ms \(attempt 1\)$/);
    assert.match(lines[1], /^\[AppAI\] text m-1 timed out after \d+ ms \(attempt 2\)$/);
});

test('the message carries the configured seconds', async () => {
    const { log } = logs();
    await assert.rejects(
        guardedAiCall(() => new Promise(() => {}), INFO, { log, env: { STUDIO_AI_CALL_TIMEOUT_MS: '500' } }),
        (e) => e.message === 'The AI gave no answer within 1 s',
    );
});

test('a provider that answers on the retry: the step succeeds', async () => {
    const { lines, log } = logs();
    let n = 0;
    const out = await guardedAiCall(
        () => (++n === 1 ? new Promise(() => {}) : Promise.resolve('answer')),
        INFO, { log, env: { STUDIO_AI_CALL_TIMEOUT_MS: '50' } },
    );
    assert.equal(out, 'answer');
    assert.equal(n, 2);
    assert.match(lines[0], /timed out after \d+ ms \(attempt 1\)/);
    assert.match(lines[1], /^\[AppAI\] text m-1 done in \d+ ms$/);
});

test('a plain error is not retried and the log holds a status, not the message', async () => {
    const { lines, log } = logs();
    let n = 0;
    const boom = Object.assign(new Error('prompt text: secret invoice 1234'), { status: 429 });
    await assert.rejects(guardedAiCall(() => { n += 1; return Promise.reject(boom); }, INFO, { log, env: {} }), (e) => e === boom);
    assert.equal(n, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[AppAI\] text m-1 failed after \d+ ms: status 429$/);
    assert.ok(!lines[0].includes('secret'));
});

test('time-out 0: no timer, no signal', async () => {
    const { lines, log } = logs();
    let seen = 'unset';
    const out = await guardedAiCall(async (signal) => { seen = signal; return 7; }, INFO, { log, env: { STUDIO_AI_CALL_TIMEOUT_MS: '0' } });
    assert.equal(out, 7);
    assert.equal(seen, undefined);
    assert.match(lines[0], /done in \d+ ms$/);
});

test('one knob: STUDIO_APP_AI_TIMEOUT_MS is read only as an alias when STUDIO_AI_CALL_TIMEOUT_MS is unset', () => {
    assert.equal(aiCallTimeoutMs({ STUDIO_APP_AI_TIMEOUT_MS: '9000' }), 9000);
    assert.equal(aiCallTimeoutMs({ STUDIO_APP_AI_TIMEOUT_MS: '9000', STUDIO_AI_CALL_TIMEOUT_MS: '50' }), 50);
    assert.equal(aiCallTimeoutMs({ STUDIO_APP_AI_TIMEOUT_MS: '0' }), 0);
    assert.equal(aiCallTimeoutMs({}), 120_000);
});
