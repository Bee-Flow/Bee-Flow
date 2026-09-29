/**
 * The native-app handoff allowlist.
 *
 * This is the one place a redirect target exists for the OAuth callback's
 * native path, and the whole security argument for that path is that the
 * client sends a KEY rather than a URL — so there is no URI for anyone to
 * craft and no parser to fool. These tests exist to keep it that way: the day
 * someone "improves" this into a prefix match or an allowlist of hosts, they
 * should have to delete a test that says why not.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveNativeAppRedirect } = require('./shared');

test('resolves the known key to its fixed target', () => {
    assert.strictEqual(resolveNativeAppRedirect('beeflow'), 'beeflow://oauth');
});

test('returns null for anything else', () => {
    for (const key of ['', 'unknown', 'BEEFLOW', 'beeflow ', ' beeflow']) {
        assert.strictEqual(resolveNativeAppRedirect(key), null, `key: ${JSON.stringify(key)}`);
    }
});

test('cannot be walked out of via the prototype chain', () => {
    // A Map, not an object literal — `?app=constructor` must not resolve to a
    // function, and `?app=__proto__` must not resolve to anything at all.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.strictEqual(resolveNativeAppRedirect(key), null, `key: ${key}`);
    }
});

test('never reflects the caller’s own string', () => {
    // The failure this guards is an allowlist that string-matches a supplied
    // URI. Every one of these is a real bypass of a naive startsWith check.
    const attempts = [
        'beeflow://oauth@evil.example',
        'beeflow:/\\/oauth',
        'beeflow://oauth.evil.example',
        'https://evil.example',
        'javascript:alert(1)',
        'beeflow://oauth#@evil.example',
    ];
    for (const attempt of attempts) {
        assert.strictEqual(resolveNativeAppRedirect(attempt), null, `attempt: ${attempt}`);
    }
});

test('ignores non-strings rather than coercing them', () => {
    for (const key of [undefined, null, 0, 1, true, {}, [], ['beeflow'], Symbol.iterator]) {
        assert.strictEqual(resolveNativeAppRedirect(key), null);
    }
});
