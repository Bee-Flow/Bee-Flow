/**
 * connectorBootstrap.ensureOrgAdminUser — nc_uid must never be overwritten.
 *
 * Regression: the guard read `user.ncUid` (camelCase) on the RAW row that
 * userStore.getUserByEmail returns, whose column is `nc_uid` — so the guard
 * was always true and EVERY bootstrap stamped admins[0]'s uid over the
 * existing binding. connectorJwt prefers the stored uid when minting the
 * session, so an affected user's WebDAV calls impersonated the wrong
 * Nextcloud account: a cross-user data path, not just a denial.
 *
 * Fake userStore injected into require.cache — no Postgres.
 *
 * Run: node --test server/auth/connectorBootstrap.ncuid.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const state = { usersByEmail: new Map(), usersById: new Map(), orgs: new Map(), updates: [] };

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', {
    getUserByEmail: async (email) => state.usersByEmail.get(email) || null,
    getUser: async (id) => state.usersById.get(id) || null,
    getOrganization: async (id) => state.orgs.get(id) || null,
    updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
    createUserWithSeatCheck: async () => ({ created: true }),
});

const { helpers } = require('./connectorBootstrap');

const ORG = { id: 'org-1' };
const EMAIL = 'admin@example.com';

function seedExistingAdmin(row = {}) {
    const user = {
        id: 'u-admin', email: EMAIL, organizationId: ORG.id, orgRole: 'org_admin',
        provider: 'nextcloud_connector',
        ...row,
    };
    state.usersByEmail.set(EMAIL, user);
    state.usersById.set(user.id, user);
    return user;
}

beforeEach(() => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.orgs.clear();
    state.updates.length = 0;
});

test('an existing snake_case nc_uid is never overwritten by a re-bootstrap', async () => {
    seedExistingAdmin({ nc_uid: 'alice' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob', ncAdminDisplayName: 'Bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.deepEqual(ncUidWrites, [],
        `re-bootstrap overwrote nc_uid: ${JSON.stringify(state.updates)} — `
        + 'the stored uid wins in connectorJwt, so this rebinds the user to another NC account');
});

test('a camelCase-only ncUid alias also blocks the overwrite', async () => {
    seedExistingAdmin({ ncUid: 'alice' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.deepEqual(ncUidWrites, []);
});

test('a user with no nc uid at all gets bound to the bootstrapping admin uid', async () => {
    seedExistingAdmin();
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    const ncUidWrites = state.updates.filter(u => 'ncUid' in u.updates);
    assert.equal(ncUidWrites.length, 1);
    assert.equal(ncUidWrites[0].updates.ncUid, 'bob');
});

test('orgRole is still repaired on re-bootstrap (the fix must not freeze other updates)', async () => {
    seedExistingAdmin({ nc_uid: 'alice', orgRole: 'agent_editor' });
    await helpers.ensureOrgAdminUser(ORG, {
        ncAdminEmail: EMAIL, ncAdminUid: 'bob',
    });
    assert.equal(state.updates.length, 1);
    assert.deepEqual(state.updates[0].updates, { orgRole: 'org_admin' });
});
