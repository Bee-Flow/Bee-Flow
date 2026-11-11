'use strict';

/**
 * The pause API of a server run (runPause.mts): what a step answers to wait, the resume token,
 * and the executor's rule that a wait only leaves it where the host can put the run on hold.
 *
 * Run: cd server && node --test appStudio/runPause.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pauseUntil, pauseUntilResumed, newResumeToken, hashResumeToken, resumeTokenMatches, isTokenHash } = require('./runPause.mts');
const { _pauseOnlyWhereItCan } = require('./actionExecutor/dispatch');

test('pauseUntil: a time (ms or a Date) and the result the step ends with', () => {
    assert.deepEqual(pauseUntil(5000), { ok: true, pause: { until: 5000, timeoutResult: null } });
    assert.deepEqual(pauseUntil(new Date(7000), { result: { waited: true } }), { ok: true, pause: { until: 7000, timeoutResult: { waited: true } } });
});

test('pauseUntilResumed: only what was given; without a timeoutResult the wait can expire', () => {
    assert.deepEqual(pauseUntilResumed({ kind: 'approval', ref: 'apr_1' }), { ok: true, pause: { kind: 'approval', ref: 'apr_1' } });
    assert.deepEqual(pauseUntilResumed({ tokenHash: 'h', until: new Date(9000), timeoutResult: null }), { ok: true, pause: { tokenHash: 'h', until: 9000, timeoutResult: null } });
    assert.equal(Object.hasOwn(pauseUntilResumed({ kind: 'approval', ref: 'a', until: 1 }).pause, 'timeoutResult'), false);
});

test('a resume token: unguessable, stored as a hash, matched in constant time, nothing malformed matches', () => {
    const a = newResumeToken();
    const b = newResumeToken();
    assert.match(a.token, /^srt_[0-9a-f]{64}$/);
    assert.notEqual(a.token, b.token);
    assert.equal(isTokenHash(a.hash), true);
    assert.equal(a.hash, hashResumeToken(a.token));
    assert.equal(a.hash.includes(a.token.slice(4)), false, 'the hash is not the token');
    assert.equal(resumeTokenMatches(a.token, a.hash), true);
    assert.equal(resumeTokenMatches(b.token, a.hash), false);
    for (const bad of [null, undefined, '', 42, {}, a.hash, a.token.slice(4), `${a.token}x`, `srt_${'f'.repeat(300)}`]) {
        assert.equal(resumeTokenMatches(bad, a.hash), false, String(bad));
    }
    assert.equal(resumeTokenMatches(a.token, null), false, 'a run without a token is not resumed with one');
    assert.equal(resumeTokenMatches(a.token, 'not-a-hash'), false);
});

test('the executor lets a wait through only for a host that can put the run on hold', () => {
    const waiting = pauseUntil(5000);
    assert.equal(_pauseOnlyWhereItCan(waiting, { canPause: true }), waiting);
    for (const ctx of [{}, { canPause: false }, { canPause: 'true' }]) {
        const out = _pauseOnlyWhereItCan(waiting, ctx);
        assert.deepEqual(out, { ok: false, error: 'This step has to wait, which only an action that runs on the server can do', code: 'pause_unsupported', retryable: false });
    }
    const plain = { ok: true, result: { id: 'rec_1' } };
    assert.equal(_pauseOnlyWhereItCan(plain, {}), plain, 'a step that does not wait is untouched');
    assert.equal(_pauseOnlyWhereItCan(null, {}), null);
});
