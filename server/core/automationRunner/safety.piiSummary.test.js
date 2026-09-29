/**
 * buildPiiSummary — the compact per-step PII record behind the canvas's
 * "colour lines by PII" mode. Aggregate counts only, grouped via the
 * canonical PII_CATEGORIES metadata; regex guardrail rule NAMES (which travel
 * in the same category lists) must never leak in as pseudo-PII.
 *
 * Run: node --test core/automationRunner/safety.piiSummary.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { buildPiiSummary } = require('./safety');

test('groups canonical ids and counts duplicates', () => {
    const s = buildPiiSummary(['Email', 'Email', 'Person', 'PhoneNumber']);
    assert.deepStrictEqual(s.categories, { Email: 2, Person: 1, PhoneNumber: 1 });
    assert.deepStrictEqual(s.groups, { Contact: 3, Personal: 1 });
    assert.strictEqual(s.source, 'guard');
    assert.strictEqual(s.degraded, undefined);
});

test('accepts detectPii entities and human labels', () => {
    const s = buildPiiSummary([
        { category: 'Email', label: 'Email Address' },
        'Email Address',                    // guards report labels
        { label: 'Person Name' },           // entity without category id
    ]);
    assert.deepStrictEqual(s.categories, { Email: 2, Person: 1 });
});

test('resolves legacy aliases to the canonical id', () => {
    const s = buildPiiSummary(['EUNationalIdentificationNumber', 'AzureStorageAccountKey']);
    assert.deepStrictEqual(s.categories, { NationalIdentificationNumber: 1, ApiKeyOrSecret: 1 });
    assert.deepStrictEqual(s.groups, { 'EU / Netherlands': 1, Digital: 1 });
});

test('regex rule names and junk are excluded; all-junk yields null', () => {
    const s = buildPiiSummary(['Email', 'block-competitor-names', 'no_ssn_rule']);
    assert.deepStrictEqual(s.categories, { Email: 1 });
    assert.strictEqual(buildPiiSummary(['some-org-rule']), null);
    assert.strictEqual(buildPiiSummary([]), null);
    assert.strictEqual(buildPiiSummary(null), null);
});

test('scan source + degraded flag are recorded verbatim', () => {
    const s = buildPiiSummary(['Email'], { source: 'scan', degraded: true });
    assert.strictEqual(s.source, 'scan');
    assert.strictEqual(s.degraded, true);
});

test('every category the platform knows lands in exactly one colourable group', () => {
    const { PII_CATEGORIES } = require('../privacy/piiDetection');
    const GROUPS = new Set(['Personal', 'Contact', 'Financial', 'Identity', 'Digital', 'Organization', 'EU / Netherlands']);
    for (const [id, meta] of Object.entries(PII_CATEGORIES)) {
        assert.ok(GROUPS.has(meta.group), `${id} has unknown group ${meta.group} — update the FE PII_GROUP_COLORS map (flow/edgeColors.js) together with this list`);
    }
});
