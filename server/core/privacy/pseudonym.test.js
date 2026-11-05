'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pseudonymFor, pseudonymCode, pseudonymSecret, ALPHABET, PREFIX } = require('./pseudonym');

const SECRET = 'a-test-secret-that-is-long-enough-0123456789';

test('the label is "Member · " and four symbols of the alphabet', () => {
    const label = pseudonymFor('u1', 'org1', SECRET);
    assert.ok(label.startsWith(PREFIX));
    const code = label.slice(PREFIX.length);
    assert.equal(code.length, 4);
    for (const ch of code) assert.ok(ALPHABET.includes(ch), ch);
    assert.equal(ALPHABET.length, 32);
    assert.doesNotMatch(ALPHABET, /[0O1I]/);
});

test('stable across calls, different across organisations and secrets', () => {
    assert.equal(pseudonymFor('u1', 'org1', SECRET), pseudonymFor('u1', 'org1', SECRET));
    const codes = new Set(['org1', 'org2', 'org3', 'org4'].map((o) => pseudonymCode('u1', o, SECRET)));
    assert.ok(codes.size >= 3, 'one person reads differently per organisation');
    assert.notEqual(pseudonymCode('u1', 'org1', SECRET), pseudonymCode('u1', 'org1', `${SECRET}x`));
});

test('people in one organisation are spread over the labels', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(pseudonymCode(`user-${i}`, 'org1', SECRET));
    assert.ok(seen.size >= 190, `only ${seen.size} distinct labels for 200 people`);
});

test('no secret, no label', () => {
    assert.throws(() => pseudonymCode('u1', 'org1', ''), /secret/);
    const saved = process.env.SESSION_SECRET;
    try {
        process.env.SESSION_SECRET = 'short';
        assert.throws(() => pseudonymSecret(), /SESSION_SECRET/);
        process.env.SESSION_SECRET = SECRET;
        assert.equal(pseudonymSecret(), SECRET);
    } finally {
        if (saved === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved;
    }
});
