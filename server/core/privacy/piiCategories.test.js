/**
 * Canonical PII-category encoding — the one vocabulary all producers write
 * and all readers parse.
 *
 * Run: node --test server/core/piiCategories.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { CANONICAL_IDS, normalizeCategory, encodeCategories, decodeCategories } = require('./piiCategories');

test('the mirrored id list matches piiDetection.ALL_PII_CATEGORY_IDS exactly', () => {
    // piiCategories.js is a leaf on purpose (no requires) — this test is the
    // drift guard for the mirror.
    const { ALL_PII_CATEGORY_IDS } = require('./piiDetection');
    assert.deepStrictEqual([...CANONICAL_IDS].sort(), [...ALL_PII_CATEGORY_IDS].sort());
});

test('normalizeCategory maps every historical producer label to a canonical id', () => {
    // GLiNER human labels (chat paths wrote entity.label).
    assert.strictEqual(normalizeCategory('Email Address'), 'Email');
    assert.strictEqual(normalizeCategory('Person Name'), 'Person');
    assert.strictEqual(normalizeCategory('Phone Number'), 'PhoneNumber');
    assert.strictEqual(normalizeCategory('IBAN'), 'InternationalBankingAccountNumber');
    assert.strictEqual(normalizeCategory("Driver's License"), 'DriversLicenseNumber');
    // Old regex-scanner labels (automation path).
    assert.strictEqual(normalizeCategory('EU National ID / BSN'), 'NationalIdentificationNumber');
    assert.strictEqual(normalizeCategory('Credit Card'), 'CreditCardNumber');
    // The long National ID label, which has already changed shape once.
    assert.strictEqual(
        normalizeCategory('National ID (BSN / DNI / NIE / codice fiscale / Steuer-ID / INSEE / rijksregister)'),
        'NationalIdentificationNumber',
    );
    // Canonical ids pass through untouched.
    assert.strictEqual(normalizeCategory('ApiKeyOrSecret'), 'ApiKeyOrSecret');
    // Case/whitespace noise.
    assert.strictEqual(normalizeCategory('  email  '), 'Email');
});

test('unknown labels and audit markers survive instead of being dropped', () => {
    assert.strictEqual(normalizeCategory('SomeFutureCategory'), 'SomeFutureCategory');
    assert.strictEqual(normalizeCategory('scan_timeout'), 'scan_timeout');
    assert.strictEqual(normalizeCategory(''), null);
    assert.strictEqual(normalizeCategory(null), null);
});

test('encodeCategories: deduped, sorted, bare-comma joined, null when empty', () => {
    assert.strictEqual(
        encodeCategories(['Phone Number', 'Email Address', 'email', 'Email']),
        'Email,PhoneNumber',
    );
    assert.strictEqual(encodeCategories([]), null);
    assert.strictEqual(encodeCategories(null), null);
    assert.ok(!encodeCategories(['Email', 'Person']).includes(', '), 'the wire encoding has no spaces');
});

test('decodeCategories reads both eras', () => {
    assert.deepStrictEqual(decodeCategories('Email,PhoneNumber'), ['Email', 'PhoneNumber']);
    assert.deepStrictEqual(decodeCategories('Email Address, Phone Number'), ['Email', 'PhoneNumber'], 'legacy ", " + labels');
    assert.deepStrictEqual(decodeCategories(''), []);
    assert.deepStrictEqual(decodeCategories(null), []);
});
