'use strict';

/**
 * The organisation an admin page works on, END TO END: the routers that work
 * on one organisation without an id in the path take `?orgId`, the
 * organisation a platform admin chose in the admin dashboard.
 *
 *   - a platform admin (users.role 'admin') naming org B works on org B;
 *   - the organisation admin of org A naming org B is refused (403);
 *   - the organisation admin of org A without `?orgId` works on org A, as before.
 *
 * Per router: requirePrimaryOrgAdmin (auth/permissionsOrgGates.js) on
 * /api/org/mcp-access and /auth/org-roles; resolveChosenOrgId
 * (auth/adminOrg.mts) on GET /auth/org-roles; and the order of the checks on the Azure
 * group-sync routes (routes/orgAzureConfig.js). Also confirmed: invitations
 * (`?orgId` on list, create and revoke), the org custom tiers (`?orgId` on GET,
 * body `orgId` on POST) and the Nextcloud sync (`:orgId` in the path). Real routers and real stores
 * over PGlite (testUtils/pglitePool.js); only the session comes from outside. The world is
 * ./permissionsOrgGates.orgChoice.testkit.js; the routers of modules are in the files beside
 * this one named after their module (permissionsOrgGates.orgChoice.<moduleId>.test.js).
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { h, ORG_A, ORG_B, PLATFORM, ADMIN_A, ADMIN_B, seedOrganisations, closeAll, threeCallers } = require('./permissionsOrgGates.orgChoice.testkit');

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    await seedOrganisations();
    api.mcpAccess = h.serve('/api/org/mcp-access', require('../routes/orgMcpAccess'));
    api.auth = h.serve('/auth', require('./adminRoutes'));
    api.azure = h.serve('/api/org-azure-config', require('../routes/orgAzureConfig'));
    api.ncSync = h.serve('/auth', require('../routes/admin/ncSync'));
    api.modelTiers = h.serve('/ai', require('../routes/ai/config/modelTiers'));
}, { timeout: 120_000 });

after(() => closeAll(api));

test('MCP access policy: a platform admin saves org B\'s policy', async () => {
    const policy = { enabled: true, ipAllowlist: ['203.0.113.0/24'], allowedUsers: { mode: 'all', roles: [], userIds: [] }, rejectLegacyTokens: true };
    const { platform, own } = await threeCallers(api.mcpAccess, 'PUT', '/api/org/mcp-access', policy);
    assert.equal(platform.status, 200, platform.text);
    assert.equal(own.status, 200, own.text);
    const seenByB = await api.mcpAccess.call('GET', '/api/org/mcp-access', { user: ADMIN_B });
    assert.deepEqual(seenByB.body.policy, policy);
    const chosen = await api.mcpAccess.call('GET', `/api/org/mcp-access?orgId=${ORG_B}`, { user: PLATFORM });
    assert.equal(chosen.status, 200, 'the query schema takes orgId');
    assert.deepEqual(chosen.body.policy, policy);
    assert.equal((await api.mcpAccess.call('GET', '/api/org/mcp-access?orgId=org-choice-none', { user: PLATFORM })).status, 404);
    assert.equal((await api.mcpAccess.call('GET', '/api/org/mcp-access?other=1', { user: PLATFORM })).status, 400, 'any other query key is still refused');
});

test('organisation roles: a platform admin edits and reads the roles of org B', async () => {
    const body = { permissions: ['manage_skills'] };
    const { platform, own } = await threeCallers(api.auth, 'PUT', '/auth/org-roles/member', body);
    assert.equal(platform.status, 200, platform.text);
    assert.equal(own.status, 200, own.text);
    const member = (res) => res.body.roles.find((r) => r.id === 'member').permissions;
    const read = await threeCallers(api.auth, 'GET', '/auth/org-roles');
    assert.equal(read.platform.status, 200, read.platform.text);
    assert.ok(member(read.platform).includes('manage_skills'));
    assert.deepEqual(member(read.platform), member(await api.auth.call('GET', '/auth/org-roles', { user: ADMIN_B })));
    assert.equal(read.own.status, 200);
});

test('Azure group sync: the org-admin check comes before the directory binding', async () => {
    for (const [method, path] of [['POST', 'sync-groups'], ['PUT', 'sync-groups/settings'], ['GET', 'sync-groups/status']]) {
        const res = await api.azure.call(method, `/api/org-azure-config/${ORG_B}/${path}`, { user: ADMIN_A, body: method === 'GET' ? undefined : {} });
        assert.equal(res.status, 403, `${method} ${path}: ${res.text.slice(0, 200)}`);
        assert.doesNotMatch(res.text, /azure_sync/, 'nothing about the binding reaches a caller who administers nothing here');
    }
    const status = await api.azure.call('GET', `/api/org-azure-config/${ORG_B}/sync-groups/status`, { user: PLATFORM });
    assert.equal(status.status, 200, status.text);
    const own = await api.azure.call('POST', `/api/org-azure-config/${ORG_B}/sync-groups`, { user: ADMIN_B, body: {} });
    assert.equal(own.status, 503, 'the admin of org B gets the binding answer: no directory is bound');
});

test('invitations: a platform admin invites into, lists and revokes in org B', async () => {
    const { platform } = await threeCallers(api.auth, 'POST', '/auth/invitations', { email: 'new-person@choice.test' });
    assert.equal(platform.status, 200, platform.text);
    const id = platform.body.invitation.id;
    const list = await threeCallers(api.auth, 'GET', '/auth/invitations');
    assert.deepEqual(list.platform.body.map((i) => i.id), [id]);
    assert.deepEqual((await api.auth.call('GET', '/auth/invitations', { user: ADMIN_B })).body.map((i) => i.id), [id]);
    assert.deepEqual(list.own.body, [], 'the admin of org A sees only org A');
    const byStranger = await api.auth.call('DELETE', `/auth/invitations/${id}`, { user: ADMIN_A });
    assert.equal(byStranger.status, 404, 'an invitation of another organisation is not found');
    assert.equal((await api.auth.call('DELETE', `/auth/invitations/${id}?orgId=${ORG_B}`, { user: ADMIN_A })).status, 403);
    const revoked = await api.auth.call('DELETE', `/auth/invitations/${id}?orgId=${ORG_B}`, { user: PLATFORM });
    assert.deepEqual([revoked.status, revoked.body.success], [200, true]);
    assert.equal((await api.auth.call('GET', '/auth/invitations?orgId=org-choice-none', { user: PLATFORM })).status, 404);
});

test('org custom tiers: ?orgId on GET, orgId in the body on POST', async () => {
    const get = await threeCallers(api.modelTiers, 'GET', '/ai/config/org-custom-chat-models');
    assert.deepEqual([get.platform.status, get.platform.body.orgId], [200, ORG_B]);
    assert.deepEqual([get.own.status, get.own.body.orgId], [200, ORG_A]);
    const post = (user, orgId) => api.modelTiers.call('POST', '/ai/config/org-custom-chat-models', { user, body: { orgId, tiers: [] } });
    assert.deepEqual(await post(PLATFORM, ORG_B).then((r) => [r.status, r.body.orgId]), [200, ORG_B]);
    assert.equal((await post(ADMIN_A, ORG_B)).status, 403);
    assert.deepEqual(await post(ADMIN_A, undefined).then((r) => [r.status, r.body.orgId]), [200, ORG_A]);
});

test('Nextcloud sync: the org in the path, strict org admin or platform admin', async () => {
    assert.equal((await api.ncSync.call('GET', `/auth/admin/${ORG_B}/nc-sync`, { user: ADMIN_A })).status, 403);
    const platform = await api.ncSync.call('GET', `/auth/admin/${ORG_B}/nc-sync`, { user: PLATFORM });
    assert.equal(platform.status, 400, `past the gate, org B has no Nextcloud: ${platform.text.slice(0, 200)}`);
    assert.equal((await api.ncSync.call('GET', `/auth/admin/${ORG_B}/nc-sync`, { user: ADMIN_B })).status, 400);
});
