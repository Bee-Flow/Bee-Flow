'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pseudonymFor, pseudonymCode, pseudonymId, pseudonymSecret, ALPHABET, PREFIX } = require('./pseudonym');

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

test('the top-people domain never shares a label with the people table', () => {
    // The people table is revealable; a top-people label equal to it would be
    // named by that reveal.
    let same = 0;
    for (let i = 0; i < 500; i++) {
        const people = pseudonymFor(`user-${i}`, 'org1', SECRET);
        const top = pseudonymFor(`user-${i}`, 'org1', SECRET, { domain: 'top-people' });
        assert.match(top, /^Member · [A-HJ-NP-Z2-9]{4}$/);
        if (people === top) same++;
    }
    assert.ok(same <= 1, `${same} of 500 top-people labels equal the people-table label`);
    assert.equal(pseudonymFor('u1', 'org1', SECRET, { domain: 'people' }), pseudonymFor('u1', 'org1', SECRET), 'people is the default domain');
    assert.equal(pseudonymFor('u1', 'org1', SECRET, { domain: 'top-people' }), pseudonymFor('u1', 'org1', SECRET, { domain: 'top-people' }), 'stable');
    assert.throws(() => pseudonymFor('u1', 'org1', SECRET, { domain: 'nope' }), /domain/);
});

test('the row id is 16 hex characters, stable, and distinct where labels collide', () => {
    assert.match(pseudonymId('u1', 'org1', SECRET), /^[0-9a-f]{16}$/);
    assert.equal(pseudonymId('u1', 'org1', SECRET), pseudonymId('u1', 'org1', SECRET));
    assert.notEqual(pseudonymId('u1', 'org1', SECRET), pseudonymId('u1', 'org2', SECRET));
    // Find two people with one label: their ids still differ.
    /** @type {Map<string, string>} */
    const byLabel = new Map();
    let pair = null;
    for (let i = 0; !pair && i < 20_000; i++) {
        const label = pseudonymCode(`user-${i}`, 'org1', SECRET);
        const other = byLabel.get(label);
        if (other) pair = [other, `user-${i}`];
        else byLabel.set(label, `user-${i}`);
    }
    assert.ok(pair, 'a label collision among 20,000 people');
    assert.equal(pseudonymFor(pair[0], 'org1', SECRET), pseudonymFor(pair[1], 'org1', SECRET));
    assert.notEqual(pseudonymId(pair[0], 'org1', SECRET), pseudonymId(pair[1], 'org1', SECRET));
    const ids = new Set();
    for (let i = 0; i < 20_000; i++) ids.add(pseudonymId(`user-${i}`, 'org1', SECRET));
    assert.equal(ids.size, 20_000);
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
