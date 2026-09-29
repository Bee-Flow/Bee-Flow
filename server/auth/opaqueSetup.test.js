/**
 * auth/opaqueSetup.js — can @serenity-kit/opaque read OPAQUE_SERVER_SETUP?
 *
 * On dev and prod the configured value (192 characters, where the library's
 * own createSetup() yields 171) could not be deserialized, so every OPAQUE
 * registration and login failed with a protocol error while every admin
 * surface said OPAQUE was configured. What this file pins:
 *
 *   - the probe rejects that shape and accepts a value the library minted;
 *   - the verdict is cached for the value it judged, and only that value;
 *   - an unreadable value logs exactly one error, which never contains the
 *     value or its length;
 *   - no configured value is not an error (the routes mint an ephemeral one).
 *
 * Runs the real WASM library; nothing is mocked through the module system.
 *
 * Run: cd server && node --test auth/opaqueSetup.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const opaque = require('@serenity-kit/opaque');

const setupCheck = require('./opaqueSetup');

const BAD = 'A'.repeat(192);
const ORIGINAL = process.env.OPAQUE_SERVER_SETUP;

function captureLog() {
    const lines = [];
    return { lines, log: { error: (...args) => { lines.push(args.map(String).join(' ')); } } };
}

test.beforeEach(() => {
    setupCheck._resetForTests();
    delete process.env.OPAQUE_SERVER_SETUP;
});

test.after(() => {
    setupCheck._resetForTests();
    if (ORIGINAL === undefined) delete process.env.OPAQUE_SERVER_SETUP;
    else process.env.OPAQUE_SERVER_SETUP = ORIGINAL;
});

test('a value the library cannot deserialize is invalid; one it minted is valid', async () => {
    await opaque.ready;
    const bad = setupCheck.probeServerSetup(opaque, BAD);
    assert.equal(bad.valid, false);
    assert.match(bad.reason, /deserialize serverSetup/);

    const good = setupCheck.probeServerSetup(opaque, opaque.server.createSetup());
    assert.deepEqual(good, { valid: true, reason: null });
});

test('validateServerSetup judges the configured value and caches the verdict for it', async () => {
    const { log } = captureLog();
    process.env.OPAQUE_SERVER_SETUP = BAD;
    const status = await setupCheck.validateServerSetup({ log });
    assert.equal(status.valid, false);
    assert.equal(setupCheck.getServerSetupStatus().valid, false);
    assert.equal(setupCheck.isServerSetupUsable(), false);

    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    assert.equal(setupCheck.getServerSetupStatus(), null,
        'a verdict must never be applied to a value it did not judge');
    assert.equal(setupCheck.isServerSetupUsable(), true, 'unknown is not known-bad');

    assert.deepEqual(await setupCheck.validateServerSetup({ log }), { valid: true, reason: null });
    assert.deepEqual(setupCheck.getServerSetupStatus(), { valid: true, reason: null });
});

test('an unreadable value logs one error that names the fix and never the value or its length', async () => {
    const { lines, log } = captureLog();
    process.env.OPAQUE_SERVER_SETUP = BAD;
    await setupCheck.validateServerSetup({ log });

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.match(line, /^\[OPAQUE\] OPAQUE_SERVER_SETUP cannot be read by @serenity-kit\/opaque \d+\.\d+\.\d+: /);
    assert.match(line, /OPAQUE registration\/login are unavailable until it is replaced \(see server\/scripts\/generate-opaque-setup\.js\)\. Password logins are unaffected\.$/);
    assert.ok(!line.includes('AAAAAAAA'), 'the value must never be logged');
    assert.ok(!/\b192\b/.test(line), 'nor its length');
});

test('a readable value logs nothing', async () => {
    const { lines, log } = captureLog();
    await opaque.ready;
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    await setupCheck.validateServerSetup({ log });
    assert.deepEqual(lines, []);
});

test('no configured value is not an error: nothing to judge, nothing logged', async () => {
    const { lines, log } = captureLog();
    const status = await setupCheck.validateServerSetup({ log });
    assert.deepEqual(status, { valid: true, reason: 'not_configured' });
    assert.equal(setupCheck.isServerSetupUsable(), true);
    assert.deepEqual(lines, []);
});

test('the reason is dropped if the library ever echoes the value', () => {
    const echoing = {
        client: { startRegistration: () => ({ registrationRequest: 'r' }) },
        server: { createRegistrationResponse: ({ serverSetup }) => { throw new Error(`bad setup ${serverSetup}`); } },
    };
    const r = setupCheck.probeServerSetup(echoing, BAD);
    assert.equal(r.valid, false);
    assert.ok(!r.reason.includes('AAAAAAAAAAAA'));
});

test('a library that fails to load makes the value unusable rather than throwing', async () => {
    const { lines, log } = captureLog();
    process.env.OPAQUE_SERVER_SETUP = BAD;
    const broken = { ready: Promise.reject(new Error('wasm compile failed')) };
    broken.ready.catch(() => { });
    const status = await setupCheck.validateServerSetup({ opaqueLib: broken, log });
    assert.equal(status.valid, false);
    assert.match(status.reason, /failed to load/);
    assert.equal(lines.length, 1);
});
