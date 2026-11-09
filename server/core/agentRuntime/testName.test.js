'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { defaultName } = require('./testName');

test('defaultName cuts at a word boundary within 60 characters and marks the cut', () => {
    assert.strictEqual(defaultName('Short question?'), 'Short question?');
    const long = 'How do I reset the password for a customer who lost access to the email address';
    const name = defaultName(long);
    assert.ok(name.length <= 60);
    assert.ok(name.endsWith('\u2026'));
    assert.ok(long.startsWith(name.slice(0, -1)));
    assert.ok(/\s/.test(long.charAt(name.length - 1)), 'the cut falls between words');
    assert.strictEqual(defaultName('x'.repeat(100)), 'x'.repeat(59) + '\u2026');
});
