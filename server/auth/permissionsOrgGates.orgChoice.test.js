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
 * /api/org/mcp-access, /auth/org-roles, /ai/learning/training-rules,
 * /ai/learning/admin, /api/mcp-library/org and /api/studio-apps/usage;
 * resolveChosenOrgId (auth/adminOrg.mts) on GET /auth/org-roles and
 * /api/integrations/github-sync; and the order of the checks on the Azure
 * group-sync routes (routes/orgAzureConfig.js). Also confirmed: invitations
 * (`?orgId` on list, create and revoke), the org custom tiers (`?orgId` on GET,
 * body `orgId` on POST) and the Nextcloud sync (`:orgId` in the path). Real routers and real stores
 * over PGlite (testUtils/pglitePool.js); only the session comes from outside.
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'org-choice-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'org-choice-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');

const ORG_A = 'org-choice-a';
const ORG_B = 'org-choice-b';
const base = { role: 'user', groups: [] };
const PLATFORM = { ...base, id: 'u-choice-platform', username: 'choice-platform', email: 'p@choice.test', organizationId: ORG_A, role: 'admin', orgRole: 'member' };
const ADMIN_A = { ...base, id: 'u-choice-admin-a', username: 'choice-admin-a', email: 'a@choice.test', organizationId: ORG_A, orgRole: 'org_admin' };
const ADMIN_B = { ...base, id: 'u-choice-admin-b', username: 'choice-admin-b', email: 'b@choice.test', organizationId: ORG_B, orgRole: 'org_admin' };

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    const plan = await userStore.createPlan({ name: 'Choice plan', tier: 'enterprise', allowed_features: ['mcp_marketplace', 'apps'] });
    for (const [id, name] of [[ORG_A, 'Org A'], [ORG_B, 'Org B']]) {
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    for (const u of [PLATFORM, ADMIN_A, ADMIN_B]) await userStore.createUser({ ...u, passwordHash: 'x' });
    const studioAppStore = require('../stores/studioAppStore');
    await studioAppStore.initDB();
    await require('../stores/studioAppDataStore').initDB();
    api.mcpAccess = h.serve('/api/org/mcp-access', require('../routes/orgMcpAccess'));
    api.auth = h.serve('/auth', require('./adminRoutes'));
    api.learning = h.serve('/ai/learning', require('../routes/ai/learning'));
    api.learningAdmin = h.serve('/ai/learning/admin', require('../routes/ai/learningAdmin'));
    api.mcpLibrary = h.serve('/api/mcp-library', require('../routes/mcpLibrary'));
    api.studioApps = h.serve('/api/studio-apps', require('../routes/studioApps/crud'));
    api.githubSync = h.serve('/api/integrations/github-sync', require('../routes/integrations/githubSync'));
    api.azure = h.serve('/api/org-azure-config', require('../routes/orgAzureConfig'));
    api.ncSync = h.serve('/auth', require('../routes/admin/ncSync'));
    api.modelTiers = h.serve('/ai', require('../routes/ai/config/modelTiers'));
}, { timeout: 120_000 });

after(async () => {
    for (const s of Object.values(api)) await s.close();
    await closePg();
});

/**
 * The three callers of one router: [status as platform admin on B, as admin of A on B, as admin of A on their own org].
 * @param {ReturnType<typeof h.serve>} server @param {string} method @param {string} path @param {unknown} [body]
 */
async function threeCallers(server, method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const platform = await server.call(method, `${path}${sep}orgId=${ORG_B}`, { user: PLATFORM, body });
    const stranger = await server.call(method, `${path}${sep}orgId=${ORG_B}`, { user: ADMIN_A, body });
    const own = await server.call(method, path, { user: ADMIN_A, body });
    assert.equal(stranger.status, 403, `${method} ${path} as the admin of org A naming org B: ${stranger.text.slice(0, 200)}`);
    return { platform, stranger, own };
}

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

test('required training: a platform admin sets org B\'s rules', async () => {
    const body = { areas: { agents: 'course-build-agent' } };
    const { platform, own } = await threeCallers(api.learning, 'PUT', '/ai/learning/training-rules', { areas: {} });
    assert.equal(platform.status, 200, platform.text);
    assert.equal(own.status, 200, own.text);
    assert.equal((await api.learning.call('PUT', `/ai/learning/training-rules?orgId=${ORG_B}`, { user: PLATFORM, body })).status, 200);
    const seenByB = await api.learning.call('GET', '/ai/learning/training-rules', { user: ADMIN_B });
    assert.equal(seenByB.body.areas.agents, 'course-build-agent');
    const seenByA = await api.learning.call('GET', '/ai/learning/training-rules', { user: ADMIN_A });
    assert.equal(seenByA.body.areas.agents, undefined);
    assert.equal((await threeCallers(api.learning, 'GET', '/ai/learning/org-overview')).platform.status, 200);
});

test('Academy courses: a platform admin lists the drafts of org B', async () => {
    const store = require('../stores/learningContentStore');
    const { doc } = store.validateCourseDoc({ title: 'Course of org B' });
    await store.saveCourse(ORG_B, doc);
    const { platform, own } = await threeCallers(api.learningAdmin, 'GET', '/ai/learning/admin/courses');
    assert.equal(platform.status, 200, platform.text);
    assert.deepEqual(platform.body.courses.map((c) => c.title), ['Course of org B']);
    assert.deepEqual(own.body.courses, []);
});

test('MCP library: the gate answers for org B', async () => {
    const { platform } = await threeCallers(api.mcpLibrary, 'GET', '/api/mcp-library/org');
    assert.notEqual(platform.status, 403, platform.text);
    assert.equal((await api.mcpLibrary.call('GET', '/api/mcp-library/org?orgId=org-choice-none', { user: PLATFORM })).status, 404);
});

test('App Studio storage: a platform admin sees the apps of org B', async () => {
    await require('../stores/studioAppStore').createStudioApp({ userId: ADMIN_B.id, organizationId: ORG_B, name: 'App of org B' });
    const { platform, own } = await threeCallers(api.studioApps, 'GET', '/api/studio-apps/usage');
    assert.equal(platform.status, 200, platform.text);
    assert.equal(platform.body.apps.length, 1);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.apps.length, 0);
});

test('GitHub sync: per organisation, a platform admin reads the status of org B', async () => {
    const { platform } = await threeCallers(api.githubSync, 'GET', '/api/integrations/github-sync/status');
    assert.equal(platform.status, 200, platform.text);
    assert.equal(platform.body.configured, false);
    const unchosen = await api.githubSync.call('GET', '/api/integrations/github-sync/status', { user: PLATFORM });
    assert.equal(unchosen.status, 400, 'without a chosen organisation a platform admin has none, as before');
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
