'use strict';
/**
 * Password and two-factor resets by an organisation admin (userRoutes.js, orgAdminGuards.js
 * credentialResetRefusal), over the real router, the real stores and a real Postgres (PGlite):
 * a member of the admin's organisation who administers ANOTHER organisation through a group of
 * it is that organisation's to manage, so the reset is refused; an ordinary member's is not.
 *
 * Run: cd server && node --test auth/admin/userRoutes.credentialReset.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'ucr-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'ucr-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');

const ORG_A = 'org-ucr-a';
const ORG_B = 'org-ucr-b';
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@ucr.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const ADMIN_A = mk('ucr-admin-a', ORG_A, { orgRole: 'org_admin' });
const MEMBER = mk('ucr-member', ORG_A);
// A member of A who administers B through an admin group of B.
const ADMIN_OF_B = mk('ucr-admin-of-b', ORG_A, { groups: ['ucr-b-admins'] });
// Another member of A who administers B; reset by a caller who administers A and B.
const ADMIN_BOTH = mk('ucr-admin-both', ORG_A, { groups: ['ucr-b-admins'] });

let api;
let userStore;

before(async () => {
    userStore = require('../../stores/userStore');
    await userStore.initDB();
    for (const id of [ORG_A, ORG_B]) await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
    await userStore.createGroup({ id: 'ucr-b-admins', name: 'B admins', organizationId: ORG_B, roles: ['org_admin'], permissions: [] });
    for (const u of [ADMIN_A, MEMBER, ADMIN_OF_B, ADMIN_BOTH]) await userStore.createUser({ ...u, passwordHash: 'x' });
    await userStore.updateUser(ADMIN_OF_B.id, { mfaEnabled: true, mfaSecret: 'secret-b' });
    api = h.serve('/', require('./userRoutes'), { user: ADMIN_A });
}, { timeout: 120_000 });

after(async () => {
    await api.close();
    await closePg();
});

test('an organisation admin cannot reset the password or two-factor of a member who administers another organisation', async () => {
    const pw = await api.call('PUT', `/users/${ADMIN_OF_B.id}`, { body: { password: 'A-long-enough-passw0rd!' } });
    assert.equal(pw.status, 403, pw.text);
    assert.equal(pw.body.code, 'admin_elsewhere_target');
    assert.equal((await userStore.getUser(ADMIN_OF_B.id)).passwordHash, 'x');

    const mfa = await api.call('POST', `/users/${ADMIN_OF_B.id}/mfa/reset`);
    assert.equal(mfa.status, 403, mfa.text);
    assert.equal(mfa.body.code, 'admin_elsewhere_target');
    assert.ok((await userStore.getUser(ADMIN_OF_B.id)).mfa_enabled);
});

test('an organisation admin still resets an ordinary member\'s two-factor', async () => {
    const res = await api.call('POST', `/users/${MEMBER.id}/mfa/reset`);
    assert.equal(res.status, 200, res.text);
});

test('a caller who administers that other organisation as well may reset', async () => {
    const both = { ...ADMIN_A, id: 'ucr-caller-both', groups: ['ucr-b-admins'] };
    await userStore.createUser({ ...both, passwordHash: 'x' });
    const res = await api.call('POST', `/users/${ADMIN_BOTH.id}/mfa/reset`, { user: both });
    assert.equal(res.status, 200, res.text);
});

test('a platform admin may reset', async () => {
    const res = await api.call('POST', `/users/${ADMIN_OF_B.id}/mfa/reset`, { user: { id: 'ucr-platform', role: 'admin' } });
    assert.equal(res.status, 200, res.text);
});
