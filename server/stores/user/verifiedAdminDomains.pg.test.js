'use strict';
/**
 * Which organisations have an administrator with a verified address on a domain
 * (verifiedAdminDomains.mts), on a real Postgres (PGlite), and the store rule it rests on: a
 * changed e-mail address is no longer a verified one (users.js updateUser).
 *
 * Run: cd server && node --test stores/user/verifiedAdminDomains.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'vad-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'vad-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close } = usePglitePool();

let userStore;
const NOW = new Date().toISOString();
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@corp.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], passwordHash: 'x', ...extra });

before(async () => {
    userStore = require('../userStore');
    await userStore.initDB();
    for (const id of ['org-v', 'org-u', 'org-m']) await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
    await userStore.createUser(mk('admin-v', 'org-v', { orgRole: 'org_admin' }));
    await userStore.createUser(mk('admin-u', 'org-u', { orgRole: 'org_admin' }));
    await userStore.createUser(mk('member-m', 'org-m'));
    await userStore.updateUser('admin-v', { emailVerifiedAt: NOW });
    await userStore.updateUser('member-m', { emailVerifiedAt: NOW });
}, { timeout: 120_000 });

after(close);

test('only an organisation administrator with a verified address on the domain counts', async () => {
    assert.deepEqual(await userStore.orgIdsWithVerifiedAdminAtDomain('CORP.test'), ['org-v']);
    assert.deepEqual(await userStore.orgIdsWithVerifiedAdminAtDomain('other.test'), []);
    assert.deepEqual(await userStore.orgIdsWithVerifiedAdminAtDomain(''), []);
});

test('a new e-mail address clears the verification; the same address in other letters keeps it', async () => {
    await userStore.updateUser('admin-v', { email: 'Admin-V@Corp.Test' });
    assert.ok((await userStore.getUser('admin-v')).email_verified_at);
    await userStore.updateUser('admin-v', { email: 'admin-v@elsewhere.test' });
    assert.equal((await userStore.getUser('admin-v')).email_verified_at, null);
    assert.deepEqual(await userStore.orgIdsWithVerifiedAdminAtDomain('elsewhere.test'), []);
    assert.deepEqual(await userStore.orgIdsWithVerifiedAdminAtDomain('corp.test'), []);
});
