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
