/**
 * A save of the Access matrix keeps the org-scoped custom integrations
 * ('custom:<uuid>': AI-builder rows and the MCP library's remote servers)
 * that it never showed (auth/admin/featureAccessRoutes.js).
 *
 * Those ids are not matrix rows (capabilityRegistry keeps them out of
 * listCapabilities), so a matrix save cannot have decided them. Before, both
 * writers replaced the stored list wholesale, so any unrelated toggle revoked
 * every org-installed MCP server for "All members" (writeOrgAccessGrants) or
 * for a group (PUT /groups/:id/access).
 *
 * No module mocking. The router is served by core/http/routeHarness with its
 * database seam (db.pool records instead of connecting), and the stores and
 * the entitlement resolver it calls through their module objects are swapped
 * per file with testUtils/swaps. requireAuth is replaced on auth/permissions
 * BEFORE the router is required (it destructures its gates at load), with a
 * session-only check like routeHarness.openGates uses; openGates itself is not
 * called because it requires auth/index, which loads this router first.
 *
 * Run: cd server && node --test auth/admin/featureAccessRoutes.customKeep.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const h = require('../../core/http/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

const db = h.recordDb();
const permissions = require('../permissions');
const swaps = makeSwaps();
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'requireAdmin', needsSession);

const router = require('./featureAccessRoutes');
const userStore = require('../../stores/userStore');
const entitlements = require('../../core/entitlements/entitlements');

// A platform super-admin: requireOrgAdmin('orgId') and the group route's own
// check both let one through without a database lookup.
const api = h.serve('/', router, { user: { id: 'root', role: 'admin', organizationId: null } });

const CAPS = [
    { id: 'gmail', kind: 'integration', name: 'Gmail', userFacing: true, groupTogglable: true },
    { id: 'drive', kind: 'integration', name: 'Drive', userFacing: true, groupTogglable: true },
    { id: 'mcp:files', kind: 'integration', name: 'Files', userFacing: true, groupTogglable: true },
    { id: 'notebooks', kind: 'core', name: 'Notebooks', userFacing: true, groupTogglable: true },
];
const LIB = 'custom:11111111-1111-4111-8111-111111111111';
const BUILT = 'custom:22222222-2222-4222-8222-222222222222';

const state = {};
function reset() {
    state.orgList = ['drive', LIB, 'mcp:files', BUILT];
    state.orgListFails = false;
    state.groups = [
        { id: 'g1', name: 'Finance', organizationId: 'orgA', granted_capabilities: ['drive', LIB] },
        { id: 'g2', name: 'Sales', organizationId: 'orgA', granted_capabilities: [] },
    ];
    state.writes = [];
}

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getOrgEnabledIntegrations', async () => {
        if (state.orgListFails) throw new Error('db down');
        return [...state.orgList];
    });
    swaps.swap(userStore, 'setOrgEnabledIntegrations', async (orgId, list) => { state.writes.push(['setOrgEnabledIntegrations', orgId, [...list]]); return true; });
    swaps.swap(userStore, 'setOrgEnabledBetaFeatures', async () => true);
    swaps.swap(userStore, 'getOrgBetaEveryone', async () => null);
    swaps.swap(userStore, 'setOrgBetaEveryone', async () => true);
    swaps.swap(userStore, 'setOrgGrantedCapabilities', async () => true);
    swaps.swap(userStore, 'logAccessAudit', async () => {});
    swaps.swap(userStore, 'getAllGroups', async () => JSON.parse(JSON.stringify(state.groups)));
    swaps.swap(userStore, 'updateGroup', async (id, patch) => { state.writes.push(['updateGroup', id, JSON.parse(JSON.stringify(patch))]); return true; });

    swaps.swap(entitlements, 'resolveEntitlements', async () => ({
        mode: 'self-hosted',
        ceiling: { core: ['notebooks'], beta: [], integration: ['gmail', 'drive', 'mcp:files'] },
        orgAvailable: { core: ['notebooks'], beta: [], integration: ['gmail', 'drive', 'mcp:files'] },
        orgEnabled: { core: [], beta: [], integration: [] },
    }));
    swaps.swap(entitlements, 'invalidateForOrg', async () => {});
    swaps.swap(entitlements.registry, 'refreshMcpIntegrationDescriptors', async () => {});
    swaps.swap(entitlements.registry, 'getCapability', (id) => CAPS.find(c => c.id === id) || null);
    swaps.swap(entitlements.registry, 'listCapabilities', () => CAPS);
});
test.beforeEach(reset);
test.after(async () => {
    swaps.restore();
    await api.close();
});

const written = (what) => state.writes.filter(w => w[0] === what).map(w => w.slice(1));

test('an "All members" save keeps every stored custom: id it was not sent', async () => {
    const res = await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: ['gmail'] } });
    assert.strictEqual(res.status, 200, res.text);
    // drive and mcp:files ARE matrix rows: this save switched them off. The two
    // custom ids are not, so they stay, after the matrix's own choice.
    assert.deepStrictEqual(written('setOrgEnabledIntegrations'), [['orgA', ['gmail', LIB, BUILT]]]);
    // The response reports what the matrix decided, not the kept ids.
    assert.deepStrictEqual(res.body.everyone, ['gmail']);
});

test('an empty "All members" save still keeps the custom ids', async () => {
    const res = await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: [] } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEnabledIntegrations'), [['orgA', [LIB, BUILT]]]);
});

test('the matrix cannot grant a custom id the org list does not already hold', async () => {
    state.orgList = ['drive'];
    const res = await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: ['gmail', LIB] } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEnabledIntegrations'), [['orgA', ['gmail']]]);
});

test('a custom id the save also sends is not duplicated', async () => {
    const res = await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: ['gmail', LIB, LIB] } });
    assert.strictEqual(res.status, 200, res.text);
    const [[, list]] = written('setOrgEnabledIntegrations');
    assert.strictEqual(list.filter(id => id === LIB).length, 1);
});

test('only custom: ids are carried over, not other unknown stored ids', async () => {
    state.orgList = ['mcp:removed-server', 'retired-integration', LIB];
    await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: ['gmail'] } });
    assert.deepStrictEqual(written('setOrgEnabledIntegrations'), [['orgA', ['gmail', LIB]]]);
});

test('when the stored list cannot be read, the save still goes through with the matrix\'s choice', async () => {
    state.orgListFails = true;
    const res = await api.call('PUT', '/organizations/orgA/org-access', { body: { granted: ['gmail'] } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEnabledIntegrations'), [['orgA', ['gmail']]]);
});

test('a group save keeps the group\'s stored custom: ids', async () => {
    const res = await api.call('PUT', '/groups/g1/access', { body: { granted: ['gmail'] } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('updateGroup'), [['g1', { grantedCapabilities: ['gmail', LIB] }]]);
    assert.deepStrictEqual(res.body.granted, ['gmail', LIB]);
});

test('a group save that sends the custom id keeps exactly one copy', async () => {
    const res = await api.call('PUT', '/groups/g1/access', { body: { granted: [LIB, 'gmail'] } });
    assert.strictEqual(res.status, 200, res.text);
    // getCapability does not know the custom id, so the clamp drops it from the
    // sent list; it comes back once, from the stored grants.
    assert.deepStrictEqual(written('updateGroup'), [['g1', { grantedCapabilities: ['gmail', LIB] }]]);
});

test('a group save cannot add a custom id the group did not hold', async () => {
    const res = await api.call('PUT', '/groups/g2/access', { body: { granted: ['gmail', BUILT] } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('updateGroup'), [['g2', { grantedCapabilities: ['gmail'] }]]);
});
