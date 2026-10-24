'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nameForLog, textForLog } = require('./logSafe');

test('nameForLog keeps the extension, the length and a short hash, never the name', () => {
    const out = nameForLog('Jan Jansen - contract.PDF');
    assert.match(out, /^pdf file, 25 chars, #[0-9a-f]{6}$/);
    assert.ok(!out.includes('Jansen'));
});

test('nameForLog is stable for the same name and differs for another', () => {
    assert.strictEqual(nameForLog('a.txt'), nameForLog('a.txt'));
    assert.notStrictEqual(nameForLog('a.txt'), nameForLog('b.txt'));
});

test('nameForLog handles names without an extension and missing names', () => {
    assert.match(nameForLog('README'), /^no-extension file, 6 chars, #/);
    assert.strictEqual(nameForLog(''), '<no name>');
    assert.strictEqual(nameForLog(undefined), '<no name>');
});

test('textForLog keeps only the length and a short hash', () => {
    const out = textForLog('Maak een plaatje van Piet op het strand');
    assert.match(out, /^<39 chars, #[0-9a-f]{6}>$/);
    assert.ok(!out.includes('Piet'));
    assert.strictEqual(textForLog(''), '<empty>');
    assert.strictEqual(textForLog(null), '<empty>');
});
