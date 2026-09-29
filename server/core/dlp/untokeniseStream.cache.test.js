/**
 * Cache-invalidation coverage for the compile-once artifact cache added in
 * M1 Step C. The alternation regex + norm map are now memoised and rebuilt
 * only when the token key set changes; these assert that a mid-stream token
 * addition (getter form) is picked up, and that reuse across unchanged calls
 * still restores correctly.
 *
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 core/dlp/untokeniseStream.cache.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createUntokeniser } = require('./untokeniseStream');

test('getter: rebuilds when a token is ADDED after the first restore (cache invalidation)', () => {
    let map = { '[email_1]': 'a@x.com' };
    const ut = createUntokeniser(() => map);
    // First call compiles artifacts for {email_1}
    assert.strictEqual(ut.restore('to [email_1]'), 'to a@x.com');
    // Grow the map mid-stream — sig must change and the new token must restore
    map = { '[email_1]': 'a@x.com', '[phone_2]': '+31600000000' };
    assert.strictEqual(ut.restore('call [phone_2] or [email_1]'), 'call +31600000000 or a@x.com');
});

test('getter: reuses cache across unchanged calls (still correct)', () => {
    const map = { '[name_1]': 'Alice' };
    const ut = createUntokeniser(() => map);
    assert.strictEqual(ut.restore('hi [name_1]'), 'hi Alice');
    assert.strictEqual(ut.restore('bye [name_1]'), 'bye Alice');
    assert.strictEqual(ut.restore('[name_1] [name_1]'), 'Alice Alice');
});

test('getter: shrinking to empty falls back to no-op', () => {
    let map = { '[x_1]': 'X' };
    const ut = createUntokeniser(() => map);
    assert.strictEqual(ut.restore('[x_1]'), 'X');
    map = {};
    assert.strictEqual(ut.restore('[x_1]'), '[x_1]'); // empty map → early return, unchanged
});

test('static map: compile-once path restores across repeated push/flush', () => {
    const ut = createUntokeniser({ '[iban_1]': 'NL00' });
    const a = ut.push('pay [iban_1] to');
    const b = ut.flush();
    assert.strictEqual((a + b).includes('NL00'), true);
    assert.strictEqual((a + b).includes('[iban_1]'), false);
});
