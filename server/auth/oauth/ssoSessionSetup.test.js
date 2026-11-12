'use strict';
/**
 * ssoSessionSetup.resolveOrgStanding: an SSO sign-in to an account that waits
 * for approval (pending, or on the waitlist) is held, unless it is the org's
 * founder or a platform admin. An existing account without an organisation is
 * placed only through its Microsoft tenant, never by its e-mail domain.
 *
 * Run: cd server && node --test auth/oauth/ssoSessionSetup.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

let row = null;
let groups = [];
let orgs = [];
const updates = [];
const { swap, restore } = makeSwaps();
const userStore = require('../../stores/userStore');
swap(userStore, 'getUser', async () => row);
swap(userStore, 'getAllGroups', async () => groups);
swap(userStore, 'getAllOrganizations', async () => orgs);
swap(userStore, 'updateUser', async (id, u) => { updates.push(u); return true; });
swap(require('../../utils/freeEmailDomains'), 'getEffectiveFreeEmailDomains', async () => new Set());
let tenantOrg = null;
swap(require('./microsoftLogin'), 'trustedMicrosoftOrg', async () => tenantOrg);
const { resolveOrgStanding } = require('./ssoSessionSetup');
test.after(restore);

const standing = () => resolveOrgStanding({ provider: 'google', user: /** @type {any} */ ({ id: 'u1', email: 'u1@gmail.com' }) });

test('a pending or waitlisted SSO account is held for approval', async () => {
    for (const status of ['pending', 'waitlist']) {
        row = { id: 'u1', role: 'user', status, organizationId: 'org-a' };
        assert.equal((await standing()).pendingApproval, true, status);
    }
});

test('a founder or platform admin awaiting approval is not held; an active account is not', async () => {
    for (const r of [
        { id: 'u1', role: 'user', status: 'waitlist', orgRole: 'org_admin', organizationId: 'org-a' },
        { id: 'u1', role: 'admin', status: 'waitlist', organizationId: 'org-a' },
        { id: 'u1', role: 'user', status: 'active', organizationId: 'org-a' },
    ]) {
        row = r;
        assert.equal((await standing()).pendingApproval, false, JSON.stringify(r));
    }
});

test('binding an org-less account by its Microsoft tenant applies only the org\'s own and plain global default groups', async () => {
    row = { id: 'u1', role: 'user', status: 'active', groups: ['mine'] };
    groups = [
        { id: 'mine', organizationId: null, permissions: ['read'] },
        { id: 'g1', organizationId: 'acme' },
        { id: 'other', organizationId: 'beta' },
        { id: 'admins', organizationId: null, permissions: ['all'] },
        { id: 'users', organizationId: null, permissions: ['read', 'chat'] },
    ];
    tenantOrg = { id: 'acme', name: 'Acme', autoApproveSSO: true, defaultGroups: ['g1', 'other', 'admins', 'users'] };
    updates.length = 0;
    try {
        await resolveOrgStanding({ provider: 'microsoft', user: /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test' }) });
        assert.equal(updates.length, 1);
        assert.equal(updates[0].organizationId, 'acme');
        assert.deepEqual(updates[0].groups, ['mine', 'g1', 'users']);
    } finally { groups = []; tenantOrg = null; }
});

test('a later sign-in of an account without an organisation is not placed by its e-mail domain', async () => {
    row = { id: 'u1', role: 'user', status: 'active', groups: [], email: 'u1@acme.test', email_verified_at: '2026-01-01' };
    orgs = [
        { id: 'acme', name: 'Acme', email: 'info@acme.test', autoApproveSSO: true, allowedDomains: [], contact_domain_verified: 'acme.test' },
        { id: 'listed', name: 'Listed', allowedDomains: ['acme.test'], autoApproveSSO: true },
    ];
    updates.length = 0;
    try {
        for (const provider of ['google', 'nextcloud']) {
            const out = await resolveOrgStanding({ provider, user: /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test', emailVerified: true }) });
            assert.equal(out.userHasOrg, false, provider);
        }
        assert.deepEqual(updates, []);
    } finally { orgs = []; }
});

test('a Google sign-in records the account\'s own address as verified, once, and no other address', async () => {
    updates.length = 0;
    row = { id: 'u1', role: 'user', status: 'active', organizationId: 'org-a', email: 'U1@Acme.test', email_verified_at: null };
    await resolveOrgStanding({ provider: 'google', user: /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test', emailVerified: true }) });
    assert.equal(updates.length, 1);
    assert.ok(updates[0].emailVerifiedAt);
    updates.length = 0;
    for (const [provider, email, verified, stamped] of [
        ['google', 'other@acme.test', true, null], ['nextcloud', 'u1@acme.test', true, null],
        ['google', 'u1@acme.test', false, null], ['google', 'u1@acme.test', true, '2026-01-01'],
    ]) {
        row = { id: 'u1', role: 'user', status: 'active', organizationId: 'org-a', email: 'u1@acme.test', email_verified_at: stamped };
        await resolveOrgStanding({ provider, user: /** @type {any} */ ({ id: 'u1', email, emailVerified: verified }) });
    }
    assert.deepEqual(updates, []);
});
