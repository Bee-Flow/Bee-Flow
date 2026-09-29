/**
 * The never-redact layer.
 *
 * A pasted meeting transcript came back with Microsoft, PostNL, Coca-Cola and
 * Capgemini each behind an [organization_N] token. None of those is personal
 * data, and hiding them costs the model the context it needs to answer.
 *
 * The dangerous failure here is the opposite one — allowlisting something that
 * IS confidential — so the matching rule is exact-on-normalised and never
 * substring. These tests pin both directions.
 *
 * Run: node --test server/core/dlp/allowTerms.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

const { buildAllowMatcher, filterAllowedEntities, normaliseAllowValue } = require('./allowTerms');

test('well-known public companies are not treated as personal data', () => {
    const m = buildAllowMatcher({});
    for (const name of ['Microsoft', 'PostNL', 'Coca-Cola', 'Capgemini', 'Power BI']) {
        assert.ok(m.isAllowed(name, 'Organization'), `${name} should be allowlisted`);
    }
});

test('spelling variants of a public company still match', () => {
    const m = buildAllowMatcher({});
    for (const variant of ['coca cola', 'CocaCola', 'COCA-COLA', ' Coca-Cola ']) {
        assert.ok(m.isAllowed(variant, 'Organization'), variant);
    }
});

test('the shipped list never silences anything but an organisation', () => {
    // "Shell" as a surname, "X" as a person — the list is organisations only.
    const m = buildAllowMatcher({});
    assert.strictEqual(m.isAllowed('Shell', 'Person'), false);
    assert.strictEqual(m.isAllowed('Microsoft', 'Person'), false);
    assert.strictEqual(m.isAllowed('Apple', 'Address'), false);
});

test('matching is exact, never substring — this is the leak guard', () => {
    const m = buildAllowMatcher({});
    // A real (fictional) client whose name merely contains an allowlisted one.
    for (const name of ['Shell Advies BV', 'Microsoft Partner Nederland', 'PostNL Pakketservice Zuid']) {
        assert.strictEqual(m.isAllowed(name, 'Organization'), false,
            `${name} must stay redacted`);
    }
});

test('an organisation can add its own never-redact terms, for any category', () => {
    const m = buildAllowMatcher({ piiAllowTerms: ['Dekker Techniek', 'Bee Flow'] });
    assert.ok(m.isAllowed('Dekker Techniek', 'Organization'));
    assert.ok(m.isAllowed('dekker-techniek', 'Organization'));
    // Own terms are not category-scoped: an admin who writes it down means it.
    assert.ok(m.isAllowed('Bee Flow', 'Person'));
    assert.strictEqual(m.isAllowed('Dekker Workforce', 'Organization'), false);
});

test('the shipped list can be switched off entirely', () => {
    const m = buildAllowMatcher({ piiAllowPublicOrgs: false, piiAllowTerms: ['Eigen BV'] });
    assert.strictEqual(m.isAllowed('Microsoft', 'Organization'), false);
    assert.ok(m.isAllowed('Eigen BV', 'Organization'));
});

test('filtering splits kept from allowed and never mutates the input', () => {
    const entities = [
        { text: 'Microsoft', category: 'Organization' },
        { text: 'Dekker Techniek', category: 'Organization' },
        { text: 'Tom Smit', category: 'Person' },
    ];
    const before = JSON.stringify(entities);
    const { entities: kept, allowed } = filterAllowedEntities(entities, buildAllowMatcher({}));

    assert.deepStrictEqual(kept.map(e => e.text), ['Dekker Techniek', 'Tom Smit']);
    assert.deepStrictEqual(allowed.map(e => e.text), ['Microsoft']);
    assert.strictEqual(JSON.stringify(entities), before, 'input was mutated');
});

test('empty and malformed input is handled without throwing', () => {
    const m = buildAllowMatcher({ piiAllowTerms: [null, '', '   ', { term: 'Geldig' }] });
    assert.strictEqual(m.isAllowed('', 'Organization'), false);
    assert.strictEqual(m.isAllowed(null, 'Organization'), false);
    assert.strictEqual(m.isAllowed('!!!', 'Organization'), false);
    assert.ok(m.isAllowed('geldig', 'Organization'), 'object-shaped terms should work');
    assert.deepStrictEqual(filterAllowedEntities(null, m), { entities: [], allowed: [] });
});

test('normalisation strips case, punctuation and whitespace only', () => {
    assert.strictEqual(normaliseAllowValue('Coca-Cola'), 'cocacola');
    assert.strictEqual(normaliseAllowValue('  A.B.N. AMRO '), 'abnamro');
    assert.strictEqual(normaliseAllowValue('---'), '');
});
