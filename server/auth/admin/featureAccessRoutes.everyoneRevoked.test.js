/**
 * Self-hosted "All members" save stores the switched-off ids as a deny-list
 * (organizations.org_everyone_revoked; auth/admin/featureAccessRoutes.js).
 *
 * buildOrgGrant reads that list on self-hosted, so a save that leaves
 * `projects` out must record it, a save that includes it again must clear it,
 * and an id the save could not decide (outside the org's access menu, or not
 * listed in the matrix) keeps its previous state, like nextBetaEveryone.
 * Cloud never writes the list.
 *
 * Seams as in featureAccessRoutes.customKeep.test.js.
 *
 * Run: cd server && node --test auth/admin/featureAccessRoutes.everyoneRevoked.test.js
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

const api = h.serve('/', router, { user: { id: 'root', role: 'admin', organizationId: null } });

const CAPS = [
    { id: 'notebooks', kind: 'core', userFacing: true, groupTogglable: true },
    { id: 'projects', kind: 'core', userFacing: true, groupTogglable: true },
    { id: 'component_designer', kind: 'core', userFacing: true, groupTogglable: true },
    { id: 'audit', kind: 'core', userFacing: false, groupTogglable: false },
    { id: 'webpages', kind: 'beta', userFacing: true, groupTogglable: true, groupScoped: false },
    { id: 'swarm', kind: 'beta', userFacing: true, groupTogglable: true, groupScoped: false },
    { id: 'meeting_notes', kind: 'beta', userFacing: true, groupTogglable: true, groupScoped: true },
    { id: 'gmail', kind: 'integration', userFacing: true, groupTogglable: true },
];

const state = {};
function reset() {
    state.mode = 'self-hosted';
    // component_designer is outside the org's access menu; swarm is a beta the
    // menu does not hold either.
    state.bound = {
        core: ['notebooks', 'projects', 'audit'],
        beta: ['webpages', 'meeting_notes'],
        integration: ['gmail'],
    };
    state.revoked = null;
    state.writes = [];
}

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getOrgEnabledIntegrations', async () => []);
    swaps.swap(userStore, 'setOrgEnabledIntegrations', async () => true);
    swaps.swap(userStore, 'setOrgEnabledBetaFeatures', async () => true);
    swaps.swap(userStore, 'getOrgBetaEveryone', async () => null);
    swaps.swap(userStore, 'setOrgBetaEveryone', async () => true);
    swaps.swap(userStore, 'setOrgGrantedCapabilities', async (orgId, ids) => { state.writes.push(['setOrgGrantedCapabilities', orgId, [...ids]]); return true; });
    swaps.swap(userStore, 'getOrgEveryoneRevoked', async () => (state.revoked == null ? null : [...state.revoked]));
    swaps.swap(userStore, 'setOrgEveryoneRevoked', async (orgId, ids) => { state.writes.push(['setOrgEveryoneRevoked', orgId, [...ids]]); return true; });
    swaps.swap(userStore, 'logAccessAudit', async () => {});

    swaps.swap(entitlements, 'resolveEntitlements', async () => ({
        mode: state.mode,
        ceiling: state.bound,
        orgAvailable: state.bound,
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
const save = (granted) => api.call('PUT', '/organizations/orgA/org-access', { body: { granted } });

test('a save without projects stores it as revoked; what stays granted is not', async () => {
    const res = await save(['notebooks', 'webpages']);
    assert.strictEqual(res.status, 200, res.text);
    // projects (core) is switched off; the group-scoped meeting_notes has its own
    // list and the non-togglable audit is never revocable.
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), [['orgA', ['projects']]]);
});

test('a switched-off beta is stored as revoked, a group-scoped beta is not', async () => {
    const res = await save(['notebooks', 'projects']);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), [['orgA', ['webpages']]]);
});

test('a save that includes projects again removes it from the list', async () => {
    state.revoked = ['projects'];
    const res = await save(['notebooks', 'projects', 'webpages']);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), [['orgA', []]]);
});

test('ids outside the org bound are carried over, not decided by the save', async () => {
    // component_designer and swarm are outside the menu: the admin could not see
    // them, so a save neither revokes nor restores them.
    state.revoked = ['component_designer', 'swarm', 'projects'];
    const res = await save(['notebooks', 'projects', 'webpages']);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), [['orgA', ['component_designer', 'swarm']]]);
});

test('an outside-the-bound id sent in the body does not get decided either', async () => {
    const res = await save(['notebooks', 'projects', 'webpages', 'swarm', 'component_designer']);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), [['orgA', []]]);
});

test('the existing grant write stays, so switching modes is not lossy', async () => {
    await save(['notebooks']);
    assert.deepStrictEqual(written('setOrgGrantedCapabilities'), [['orgA', ['notebooks']]]);
});

test('cloud never writes the list', async () => {
    state.mode = 'cloud';
    const res = await save(['notebooks']);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(written('setOrgEveryoneRevoked'), []);
    assert.deepStrictEqual(written('setOrgGrantedCapabilities'), [['orgA', ['notebooks']]]);
});
