/**
 * Unit tests for utils/freeEmailDomains.
 *
 * Run: cd server && node --test utils/freeEmailDomains.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
    FREE_EMAIL_DOMAINS,
    isFreeEmailDomain,
    normalizeDomain,
} = require('./freeEmailDomains');

test('isFreeEmailDomain: known global providers are blocked', () => {
    for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me']) {
        assert.strictEqual(isFreeEmailDomain(d), true, `${d} should be free`);
    }
});

test('isFreeEmailDomain: corporate domains are not blocked', () => {
    for (const d of ['acme.com', 'beeflow.nl', 'example.org']) {
        assert.strictEqual(isFreeEmailDomain(d), false, `${d} should not be free`);
    }
});

test('isFreeEmailDomain accepts a full email address', () => {
    assert.strictEqual(isFreeEmailDomain('someone@gmail.com'), true);
    assert.strictEqual(isFreeEmailDomain('someone@acme.com'), false);
});

test('isFreeEmailDomain is case- and whitespace-insensitive', () => {
    assert.strictEqual(isFreeEmailDomain('  GMail.COM '), true);
    assert.strictEqual(isFreeEmailDomain('SomeOne@GMAIL.com'), true);
});

test('isFreeEmailDomain: non-strings and empties are false', () => {
    for (const v of [null, undefined, 123, {}, [], '', '   ']) {
        assert.strictEqual(isFreeEmailDomain(v), false);
    }
});

test('isFreeEmailDomain: extra set extends the built-in floor', () => {
    const extra = new Set(['acme.com']);
    assert.strictEqual(isFreeEmailDomain('acme.com', extra), true, 'extra domain now blocked');
    assert.strictEqual(isFreeEmailDomain('gmail.com', extra), true, 'floor still applies');
    assert.strictEqual(isFreeEmailDomain('other.com', extra), false, 'unrelated domain still allowed');
});

test('normalizeDomain: bare domain, address, and junk', () => {
    assert.strictEqual(normalizeDomain('Gmail.com'), 'gmail.com');
    assert.strictEqual(normalizeDomain('  x@Proton.ME '), 'proton.me');
    assert.strictEqual(normalizeDomain('@@acme.com'), 'acme.com');
    assert.strictEqual(normalizeDomain('not a domain'), null);
    assert.strictEqual(normalizeDomain('localhost'), null);
    assert.strictEqual(normalizeDomain(null), null);
});

test('the built-in floor is a non-trivial set and contains gmail', () => {
    assert.ok(FREE_EMAIL_DOMAINS.size > 30, 'floor should be comprehensive');
    assert.ok(FREE_EMAIL_DOMAINS.has('gmail.com'));
});
