// @typecheck strict
/**
 * buildUserIdentity: the account block the chat prompt carries, and the known
 * values the memory tokeniser replaces without a detector.
 *
 * Run: cd server && node --test core/memory/userIdentityContext.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildUserIdentity, loadUserIdentity } = require('./userIdentityContext');

test('name, e-mail, organisation and role from the account', () => {
    const r = buildUserIdentity(
        { displayName: 'Ada Visser', email: 'ada@example.test', orgRole: 'admin' },
        { name: 'Example BV' },
    );
    assert.match(r.text, /^<about_the_user>\n/);
    assert.match(r.text, /Name: Ada Visser\nE-mail: ada@example\.test\nOrganisation: Example BV\nRole in this workspace: admin\n<\/about_the_user>/);
    assert.deepStrictEqual(r.knownEntities.map((k) => [k.category, k.text]), [
        ['Person', 'Ada Visser'], ['Email', 'ada@example.test'], ['Organization', 'Example BV'],
    ]);
});

test('first + last name when there is no display name; empty fields left out', () => {
    const r = buildUserIdentity({ firstName: 'Ada', lastName: 'Visser', email: '' });
    assert.match(r.text, /Name: Ada Visser/);
    assert.ok(!r.text.includes('E-mail'));
    assert.ok(!r.text.includes('Organisation'));
});

test('no user or nothing known: no block', () => {
    assert.deepStrictEqual(buildUserIdentity(null), { text: '', knownEntities: [] });
    assert.deepStrictEqual(buildUserIdentity({}), { text: '', knownEntities: [] });
});

test('loadUserIdentity reads the org and never throws', async () => {
    const userStore = {
        getUser: async () => ({ displayName: 'Ada Visser', organizationId: 'o1' }),
        getOrganization: async (/** @type {string} */ id) => (id === 'o1' ? { name: 'Example BV' } : null),
    };
    const r = await loadUserIdentity('u1', { userStore });
    assert.match(r.text, /Organisation: Example BV/);
    const broken = await loadUserIdentity('u1', { userStore: { getUser: async () => { throw new Error('db'); } } });
    assert.deepStrictEqual(broken, { text: '', knownEntities: [] });
});
