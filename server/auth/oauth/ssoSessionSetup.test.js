'use strict';
/**
 * ssoSessionSetup.resolveOrgStanding: an SSO sign-in to an account that waits
 * for approval (pending, or on the waitlist) is held, unless it is the org's
 * founder or a platform admin. An existing account without an organisation is
 * placed through its Microsoft tenant or an organisation's allowedDomains, never
 * by an organisation's contact e-mail domain.
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
const { resolveOrgStanding, writeOAuthSession } = require('./ssoSessionSetup');
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

test('a later sign-in of an account without an organisation is placed through an organisation\'s allowedDomains', async () => {
    row = { id: 'u1', role: 'user', status: 'active', groups: [], email: 'u1@acme.test', email_verified_at: '2026-01-01' };
    orgs = [{ id: 'listed', name: 'Listed', allowedDomains: ['acme.test'], autoApproveSSO: true, defaultGroups: [] }];
    updates.length = 0;
    try {
        const out = await resolveOrgStanding({ provider: 'nextcloud', user: /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test' }) });
        assert.equal(out.userHasOrg, true);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].organizationId, 'listed');
        assert.equal(updates[0].status, 'active');
        // Two organisations listing the domain place nobody.
        orgs = [...orgs, { id: 'listed-2', name: 'Listed 2', allowedDomains: ['acme.test'], autoApproveSSO: true }];
        updates.length = 0;
        assert.equal((await resolveOrgStanding({ provider: 'google', user: /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test', emailVerified: true }) })).userHasOrg, false);
        assert.deepEqual(updates, []);
    } finally { orgs = []; }
});

test('a later sign-in of an account without an organisation is not placed by a contact e-mail domain', async () => {
    row = { id: 'u1', role: 'user', status: 'active', groups: [], email: 'u1@acme.test', email_verified_at: '2026-01-01' };
    orgs = [{ id: 'acme', name: 'Acme', email: 'info@acme.test', autoApproveSSO: true, allowedDomains: [], contact_domain_verified: 'acme.test' }];
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

test('an account that has an organisation, and a personal account, are never placed in another one', async () => {
    orgs = [{ id: 'listed', name: 'Listed', allowedDomains: ['acme.test'], autoApproveSSO: true, defaultGroups: [] }];
    const user = /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test' });
    updates.length = 0;
    try {
        row = { id: 'u1', role: 'user', status: 'active', organizationId: 'org-home', email: 'u1@acme.test', email_verified_at: '2026-01-01' };
        const member = await resolveOrgStanding({ provider: 'nextcloud', user });
        assert.equal(member.userHasOrg, true);

        row = { id: 'u1', role: 'user', status: 'active', groups: [], email: 'u1@acme.test', email_verified_at: '2026-01-01' };
        const personal = await resolveOrgStanding({ provider: 'nextcloud', user, signupIntent: /** @type {any} */ ({ accountType: 'consumer' }) });
        assert.deepEqual([personal.userHasOrg, personal.isPersonalAccount], [false, true]);

        // No address to match on: nobody is asked for the organisations.
        const noAddress = await resolveOrgStanding({ provider: 'nextcloud', user: /** @type {any} */ ({ id: 'u1' }) });
        assert.equal(noAddress.userHasOrg, false);
        assert.deepEqual(updates, [], 'nobody was moved');
    } finally { orgs = []; }
});

test('a Microsoft session is written only for the identity the account is bound to', async () => {
    const identityStore = require('../../stores/microsoftIdentityStore');
    const user = /** @type {any} */ ({ id: 'u1', email: 'u1@acme.test', azureTenantId: 'tenant-1', azureUserId: 'oid-1' });
    /** @type {any} */
    let binding = null;
    const undo = swap(identityStore, 'getIdentityBinding', async () => binding);
    const write = async () => {
        const req = /** @type {any} */ ({ session: {} });
        // Only the binding check and the identity it writes are under test: what comes after needs the vault and the key store.
        const error = await writeOAuthSession({ req, provider: 'microsoft', user, freshUser: null, tokenData: { access_token: 'at' }, pendingApproval: false, userHasOrg: true, isPersonalAccount: false })
            .then(() => null, (/** @type {Error} */ e) => e);
        return { session: req.session, error };
    };
    try {
        for (const other of [null, { azureTenantId: 'tenant-2', azureUserId: 'oid-1' }, { azureTenantId: 'tenant-1', azureUserId: 'oid-2' }]) {
            binding = other;
            const refused = await write();
            assert.match(String(refused.error?.message), /binding changed during login/, JSON.stringify(other));
            assert.deepEqual(refused.session, {}, 'nothing was written to the session');
        }
        binding = { azureTenantId: 'tenant-1', azureUserId: 'oid-1' };
        const written = await write();
        assert.doesNotMatch(String(written.error?.message), /binding changed during login/);
        assert.equal(written.session.isAuthenticated, true);
        assert.equal(written.session.user, user);
        assert.equal(written.session.microsoftLoginIdentity, binding);
        assert.equal(written.session.microsoftIdentityVersion, 2);
    } finally { undo(); }
});
