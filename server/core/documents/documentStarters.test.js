'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { starters } = require('./documentStarters');

const nameOf = (locale, id) => starters(locale).find((s) => s.id === id)?.name;

test('a starter is named as its document type is: Quote and Security statement', () => {
    assert.strictEqual(nameOf('en', 'proposal'), 'Quote');
    assert.strictEqual(starters('en').find((s) => s.id === 'proposal')?.docType, 'quote');
    assert.strictEqual(nameOf('en', 'security'), 'Security statement');
});

test('in Dutch: Offerte and Beveiligingsverklaring', () => {
    assert.strictEqual(nameOf('nl', 'proposal'), 'Offerte');
    assert.strictEqual(nameOf('nl', 'security'), 'Beveiligingsverklaring');
});

test('no field repeats its label as its help line', () => {
    for (const locale of ['en', 'nl']) {
        for (const s of starters(locale)) {
            for (const field of s.settings.contract.parameters) {
                assert.notStrictEqual(String(field.summary || '').trim().toLowerCase(), String(field.label).trim().toLowerCase(), `${s.id}.${field.key}`);
            }
        }
    }
});

test('the total of a quote and an invoice stands apart from the table above it', () => {
    for (const id of ['proposal', 'invoice']) {
        const s = starters('en').find((x) => x.id === id);
        assert.match(s.bodyHtml, /<\/table><p class="doc-total">/);
        assert.match(s.css, /table \{[^}]*margin: 12pt 0/);
        assert.match(s.css, /\.doc-total \{[^}]*margin-top: 12pt/);
    }
});

test('a label that already says Verified is not called "the verified verified total"', () => {
    for (const locale of ['en', 'nl']) {
        const text = JSON.stringify(starters(locale));
        assert.doesNotMatch(text, /verified verified|geverifieerde waarde voor geverifieerd/i, locale);
    }
    assert.match(JSON.stringify(starters('en')), /Supply the verified total\./);
});
