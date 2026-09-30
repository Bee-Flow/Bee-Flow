'use strict';

/**
 * Names for the people a documents answer mentions (documentPeople.js): the
 * reader's own organisation only, a name and nothing else, and a failed
 * lookup leaves that person unnamed instead of failing the answer.
 *
 * Run: cd server && node --test core/documents/documentPeople.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { describePeople, displayNameOf } = require('./documentPeople');

const USERS = {
    ann: { id: 'ann', organizationId: 'org1', displayName: 'Ann Smit', email: 'ann@example.test', phone: '123' },
    ben: { id: 'ben', organizationId: 'org1', firstName: 'Ben', lastName: 'Bos' },
    cas: { id: 'cas', organizationId: 'org2', displayName: 'Cas' },
    ned: { id: 'ned', organizationId: 'org1' },
};
const deps = (warns = []) => ({
    getUser: async (id) => { if (id === 'broken') throw new Error('db down'); return USERS[id] || null; },
    log: { warn: (...a) => warns.push(a) },
});

test('names only, only for the reader\'s organisation', async () => {
    const people = await describePeople(['ann', 'ben', 'cas', 'ghost', null, 'ann'], 'org1', deps());
    assert.deepStrictEqual(people, { ann: { name: 'Ann Smit' }, ben: { name: 'Ben Bos' } });
    assert.ok(!('email' in people.ann), 'never an e-mail address or phone number');
});

test('a person without a name is known but unnamed; a failed lookup is logged, not thrown', async () => {
    const warns = [];
    const people = await describePeople(['ned', 'broken'], 'org1', deps(warns));
    assert.deepStrictEqual(people, { ned: {} });
    assert.strictEqual(warns.length, 1);
});

test('the display name prefers the chosen name, then the full name, then the username', () => {
    assert.strictEqual(displayNameOf({ displayName: ' Ann ', firstName: 'A', username: 'a' }), 'Ann');
    assert.strictEqual(displayNameOf({ firstName: 'Ben', lastName: 'Bos', username: 'b' }), 'Ben Bos');
    assert.strictEqual(displayNameOf({ username: 'cas' }), 'cas');
    assert.strictEqual(displayNameOf({}), undefined);
});
