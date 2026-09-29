'use strict';

// Regression tests for the PII scan-result cache key. Run: node --test
//
// The key used to be `pii:${channel}:${text.length}:${text.slice(0, 200)}`,
// which was a CORRECTNESS bug rather than a weak cache:
//
//   * Two different texts sharing a length and a 200-char prefix shared an
//     entry. On a hit, validateInputForPii passes the cached entities to
//     tokenizeText, which splices by offset/length — so it redacted the
//     character ranges of a DIFFERENT message: corrupting the text while
//     leaving the real PII in place. Templated prompts with a long fixed
//     header hit this trivially.
//   * The key ignored enabledCategories and confidenceThreshold, so an admin
//     narrowing the shield or moving the confidence slider had no effect for
//     up to 5 minutes, and a narrow scan's result could be served to a caller
//     that had asked for all categories.
//
// This file used to lift cacheKey() out of the source with a regex and eval
// it, on the belief that it was module-private. It is exported, so the real
// one is imported and the cache it addresses is exercised with it.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { cacheKey, cache, cacheGet, cacheSet } = require('./piiDetection/scanCache');
const CATS = ['Email', 'PhoneNumber'];

test('different texts sharing a length and 200-char prefix do NOT collide', () => {
    // The exact shape of the original bug: identical header, identical length,
    // different payload beyond the 200th character.
    const header = 'H'.repeat(200);
    const a = header + 'mijn iban is NL91ABNA0417164300';
    const b = header + 'mijn iban is NL02RABO0123456789';
    assert.strictEqual(a.length, b.length, 'test fixture must hold length equal');
    assert.notStrictEqual(
        cacheKey('user_input', a, CATS, 0.7),
        cacheKey('user_input', b, CATS, 0.7),
    );
});

test('a one-character change anywhere changes the key', () => {
    const base = 'x'.repeat(5000) + 'tail';
    const changed = 'x'.repeat(5000) + 'tai1';
    assert.notStrictEqual(
        cacheKey('user_input', base, CATS, 0.7),
        cacheKey('user_input', changed, CATS, 0.7),
    );
});

test('enabled categories are part of the key', () => {
    const t = 'bel me op 0644137044';
    assert.notStrictEqual(
        cacheKey('user_input', t, ['Email'], 0.7),
        cacheKey('user_input', t, ['PhoneNumber'], 0.7),
    );
});

test('confidence threshold is part of the key', () => {
    const t = 'bel me op 0644137044';
    assert.notStrictEqual(
        cacheKey('user_input', t, CATS, 0.7),
        cacheKey('user_input', t, CATS, 0.9),
    );
});

test('category ORDER does not change the key (so equivalent configs share)', () => {
    const t = 'bel me op 0644137044';
    assert.strictEqual(
        cacheKey('user_input', t, ['Email', 'PhoneNumber'], 0.7),
        cacheKey('user_input', t, ['PhoneNumber', 'Email'], 0.7),
    );
});

test('channels are separated', () => {
    const t = 'bel me op 0644137044';
    assert.notStrictEqual(
        cacheKey('user_input', t, CATS, 0.7),
        cacheKey('assistant_output', t, CATS, 0.7),
    );
});

test('identical inputs produce a stable key', () => {
    const t = 'mijn email is jan@example.nl';
    assert.strictEqual(
        cacheKey('user_input', t, CATS, 0.7),
        cacheKey('user_input', t, CATS, 0.7),
    );
});

test('empty / missing category list is distinct from a narrow one', () => {
    const t = 'mijn email is jan@example.nl';
    const all = cacheKey('user_input', t, null, 0.7);
    assert.strictEqual(all, cacheKey('user_input', t, [], 0.7), 'empty means all');
    assert.notStrictEqual(all, cacheKey('user_input', t, ['Email'], 0.7));
});

test('the key does not embed the raw text (no PII in cache keys or logs)', () => {
    const secret = 'NL91ABNA0417164300';
    const key = cacheKey('user_input', `mijn iban is ${secret}`, CATS, 0.7);
    assert.ok(!key.includes(secret), 'cache key must not contain the scanned text');
    assert.ok(key.includes(crypto.createHash('sha256')
        .update(`mijn iban is ${secret}`, 'utf8').digest('hex')));
});

// ── The cache the key addresses ───────────────────────────────────────
// A key that distinguishes two scans is only worth anything if the store it
// addresses distinguishes them too: the original bug handed one message's
// entity offsets to another message's tokeniser.

test('two texts that differ past the 200th character get their own cache entries', () => {
    cache.clear();
    const header = 'H'.repeat(200);
    const a = header + 'mijn iban is NL91ABNA0417164300';
    const b = header + 'mijn iban is NL02RABO0123456789';

    cacheSet(cacheKey('user_input', a, CATS, 0.7), { entities: [{ label: 'IBAN', offset: 213 }] });
    assert.strictEqual(cacheGet(cacheKey('user_input', b, CATS, 0.7)), null,
        'b must not be served a\'s entity offsets — splicing them into b corrupts the text and leaves the real PII');
    assert.deepStrictEqual(cacheGet(cacheKey('user_input', a, CATS, 0.7)), { entities: [{ label: 'IBAN', offset: 213 }] });
    cache.clear();
});

test('narrowing the shield is not served the wider scan\'s result', () => {
    cache.clear();
    const t = 'mijn email is jan@example.nl en ik bel 0644137044';
    cacheSet(cacheKey('user_input', t, null, 0.7), { entities: [{ label: 'Email' }, { label: 'PhoneNumber' }] });

    assert.strictEqual(cacheGet(cacheKey('user_input', t, ['Email'], 0.7)), null,
        'an admin who narrowed the categories must not keep getting the old, wider answer');
    assert.strictEqual(cacheGet(cacheKey('user_input', t, null, 0.9)), null,
        'nor may moving the confidence slider be ignored for five minutes');
    cache.clear();
});
