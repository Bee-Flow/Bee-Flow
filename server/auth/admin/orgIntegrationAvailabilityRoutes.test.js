'use strict';
/**
 * GET /auth/organizations/:orgId/integration-availability
 * (auth/admin/orgIntegrationAvailabilityRoutes.mts, mounted by
 * featureAccessRoutes.js) over the real router, its real gate, the real use
 * case and the real stores on PGlite: an organisation admin of the org and a
 * platform admin get the answer, an organisation admin of ANOTHER org, a plain
 * member and no session do not.
 *
 * Run: cd server && node --test auth/admin/orgIntegrationAvailabilityRoutes.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'avail-route-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'avail-route-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');

const ORG_A = 'org-avail-route-a';
const ORG_B = 'org-avail-route-b';
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@avail.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const ADMIN_A = mk('avail-admin-a', ORG_A, { orgRole: 'org_admin' });
const ADMIN_B = mk('avail-admin-b', ORG_B, { orgRole: 'org_admin' });
const MEMBER_A = mk('avail-member-a', ORG_A);
const PLATFORM = mk('avail-platform', null, { role: 'admin' });
const URL_A = `/auth/organizations/${ORG_A}/integration-availability`;

let api;
let configStore;

before(async () => {
    const userStore = require('../../stores/userStore');
    configStore = require('../../stores/configStore');
    await userStore.initDB();
    for (const id of [ORG_A, ORG_B]) await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
    for (const u of [ADMIN_A, ADMIN_B, MEMBER_A, PLATFORM]) await userStore.createUser({ ...u, passwordHash: 'x' });
    // The rows are asked about with every module present, also when the suite runs with the modules
    // hidden (an absent module's rows leave the projection: core/entitlements/capabilityProjection.characterisation.test.js).
    const registry = require('../../core/entitlements/capabilityRegistry');
    registry.refreshModuleCapabilityFilter = async () => {};
    registry.setInactiveModuleCapabilityIds(new Set());
    api = h.serve('/auth', require('./featureAccessRoutes'), { user: ADMIN_A });
}, { timeout: 120_000 });

after(async () => {
    await api.close();
    // createOrganization writes each org's webhook signing key in a setImmediate.
    for (let i = 0; i < 100; i++) {
        const keys = await Promise.all([ORG_A, ORG_B].map(id => configStore.getSecretFresh(`org_webhook_signing_key_${id}`)));
        if (keys.every(Boolean)) break;
        await new Promise(resolve => setImmediate(resolve));
    }
    await closePg();
});

test('the organisation admin of the org gets the availability of their own org', async () => {
    const res = await api.call('GET', URL_A);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.orgId, ORG_A);
    assert.equal(res.body.homeOrg, true);
    assert.equal(typeof res.body.families.google.available, 'boolean');
    assert.equal(res.body.nextcloud.bound, false);
    assert.equal(typeof res.body.integrations.fireflies.serverConfigured, 'boolean');
});

test('a platform admin gets the availability of any org, not as their home org', async () => {
    const res = await api.call('GET', URL_A, { user: PLATFORM });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.orgId, ORG_A);
    assert.equal(res.body.homeOrg, false);
});

test('the organisation admin of ANOTHER org is refused', async () => {
    const res = await api.call('GET', URL_A, { user: ADMIN_B });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.families, undefined);
});

test('a plain member of the org and a caller without a session are refused', async () => {
    assert.equal((await api.call('GET', URL_A, { user: MEMBER_A })).status, 403);
    assert.equal((await api.call('GET', URL_A, { user: null })).status, 401);
});

test('the Access matrix and the access menu say per integration row whether it is set up on this server', async () => {
    const matrix = await api.call('GET', `/auth/organizations/${ORG_A}/group-access`);
    assert.equal(matrix.status, 200, matrix.text);
    const rows = matrix.body.capabilities.filter((c) => c.kind === 'integration').map((c) => c.id);
    assert.ok(rows.includes('gmail'));
    assert.deepEqual(Object.keys(matrix.body.serverConfigured).sort(), [...rows].sort(), 'one flag per integration row, nothing else');
    // No Google sign-in app is stored on this test server.
    assert.deepEqual(matrix.body.serverConfigured.gmail, { serverConfigured: false, reason: 'not_configured' });
    assert.deepEqual(matrix.body.serverConfigured.fireflies, { serverConfigured: true });

    const menu = await api.call('GET', `/auth/organizations/${ORG_A}/org-availability`, { user: PLATFORM });
    assert.equal(menu.status, 200, menu.text);
    assert.deepEqual(menu.body.serverConfigured.gmail, { serverConfigured: false, reason: 'not_configured' });
});

test('an org that does not exist is a 404 for a platform admin', async () => {
    const res = await api.call('GET', '/auth/organizations/org-avail-route-missing/integration-availability', { user: PLATFORM });
    assert.equal(res.status, 404, res.text);
});
