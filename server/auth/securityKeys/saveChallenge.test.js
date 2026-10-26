// @typecheck strict
'use strict';
/**
 * saveChallenge: the session holding a WebAuthn challenge is saved before the
 * options go out, and a failed save is a retryable 503 for the client.
 *
 * Run: cd server && node --test auth/securityKeys/saveChallenge.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saveChallenge } = require('./saveChallenge');
const { HttpError } = require('../../shared/httpErrors');

function recordingLog() {
    /** @type {string[]} */
    const warnings = [];
    return { warnings, warn: (/** @type {unknown[]} */ ...args) => warnings.push(args.join(' ')) };
}

test('resolves once the session is saved', async () => {
    const log = recordingLog();
    let saved = false;
    await saveChallenge({ session: { save: (cb) => { saved = true; cb(); } } }, log);
    assert.equal(saved, true);
    assert.deepEqual(log.warnings, []);
});

test('a failed save becomes a 503 session_unavailable and is logged', async () => {
    const log = recordingLog();
    const req = { session: { save: (/** @type {(err?: Error) => void} */ cb) => cb(new Error('redis down')) } };
    await assert.rejects(saveChallenge(req, log), (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 503);
        assert.equal(err.code, 'session_unavailable');
        assert.equal(err.message, 'Could not start the security key check. Try again.');
        return true;
    });
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0], /redis down/);
});
