/**
 * decryptAudit: the bulk-decrypt alert counts any 60 seconds (a sliding
 * window), not fixed minutes that start at a user's first decrypt.
 *
 * The window used to tumble: it reset at the first decrypt more than a
 * minute after it opened, so 49 decrypts at the end of one window plus 49 at
 * the start of the next (98 in about two seconds) never reached the
 * threshold of 50, and the Art-33 BREACH_SIGNAL was never emitted.
 *
 * Run: cd server && node --test auth/decryptAudit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

const emitted = [];
const restore = installResolveStub({
    '../compliance/events': { EVENTS: { BREACH_SIGNAL: 'breach_signal' }, emit: (name, payload) => emitted.push({ name, payload }) },
    '../telemetry/log': { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
});
const audit = require('./decryptAudit');
test.after(restore);

let t = 0;
test.beforeEach((ctx) => {
    emitted.length = 0;
    t = 0;
    ctx.mock.method(Date, 'now', () => t);
});

function decrypts(userId, n, at) {
    for (let i = 0; i < n; i++) { t = typeof at === 'function' ? at(i) : at; audit.trackDecrypt(userId); }
}

test('a burst that straddles the old window boundary alerts once', () => {
    decrypts('u-straddle', 1, 0);
    decrypts('u-straddle', 48, 59000);
    decrypts('u-straddle', 49, (i) => 60500 + Math.round(i * (500 / 48)));
    assert.equal(emitted.length, 1, '98 decrypts in about two seconds');
    assert.equal(emitted[0].name, 'breach_signal');
    assert.equal(emitted[0].payload.source, 'bulk_decrypt');
    assert.equal(emitted[0].payload.userId, 'u-straddle');
});

test('fifty decrypts within the first second alert exactly once', () => {
    decrypts('u-fifty', 50, (i) => Math.round(i * (1000 / 49)));
    assert.equal(emitted.length, 1);
});

test('forty-nine decrypts inside one minute stay below the threshold', () => {
    decrypts('u-quiet', 49, (i) => i * 1000);
    assert.equal(emitted.length, 0);
    assert.deepEqual(audit.getDecryptStats('u-quiet'), { count: 49, windowStart: 0 });
});

test('a sustained burst alerts at most once a minute', () => {
    decrypts('u-sustained', 200, (i) => i * 100);   // 200 decrypts over 20 s
    assert.equal(emitted.length, 1);
    decrypts('u-sustained', 50, (i) => 80000 + i * 10);
    assert.equal(emitted.length, 2, 'a minute later the next burst alerts again');
});
