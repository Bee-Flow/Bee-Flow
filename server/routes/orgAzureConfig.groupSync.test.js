// @typecheck
/**
 * Who reads an organisation's group sync, and what they read
 * (GET /api/org-azure-config/:orgId/sync-groups/status, routes/orgAzureConfig.js):
 *
 *   - the organisation admin of orgA reads orgA's status, its settings and
 *     whether a directory is connected, and none of the directory connection's
 *     own values (tenant, application id, secret, addresses);
 *   - the same admin is refused for orgB, where they are a plain group member;
 *   - a plain member of orgA is refused;
 *   - a platform admin reads it too.
 *
 * The router runs for real behind testUtils/routeHarness; the stores and the
 * session gate are swapped (testUtils/swaps) BEFORE the router is required,
 * because it destructures them at load. The org-admin decision
 * (permissions._evalOrgAdmin behind isOrgAdminForOrg) is never replaced.
 *
 * Run: cd server && node --test routes/orgAzureConfig.groupSync.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const h = require('../testUtils/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

const db = h.recordDb();
const permissions = require('../auth/permissions');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const swaps = makeSwaps();

const TENANT = '44444444-4444-4444-4444-444444444444';
const CLIENT_ID = 'client-id-7d1f';
const CLIENT_SECRET = 'client-secret-93ab';

/** @type {import('express').RequestHandler} */
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'loadConfig', async () => ({
    providers: { microsoft: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT } },
}));

const USERS = [
    { id: 'ann', organizationId: 'orgA', groups: ['g_a', 'g_b'], orgRole: 'org_admin', role: 'user' },
    { id: 'ben', organizationId: 'orgA', groups: ['g_a'], orgRole: 'member', role: 'user' },
];
const GROUPS = [
    { id: 'g_a', organizationId: 'orgA' },
    { id: 'g_b', organizationId: 'orgB' },
];
/** @type {Record<string, unknown>} */
const CONFIG = {
    azure_group_sync_binding: { syncOrganizationId: 'orgA', syncTenantId: TENANT, configuredBy: 'root' },
    azure_group_sync_status_orgA: {
        lastSyncAt: '2026-11-10T09:00:00.000Z', lastSyncResult: 'success', syncedGroups: 3, syncedUsers: 8, errors: [],
        tenantId: TENANT, endpoint: 'https://login.microsoftonline.com/',
    },
    azure_group_sync_orgA: { periodicSync: true, syncIntervalHours: 12 },
};

const copy = (/** @type {unknown} */ v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => copy(USERS.find((u) => u.id === id)));
swaps.swap(userStore, 'getAllGroups', async () => copy(GROUPS));
swaps.swap(configStore, 'getConfig', async (/** @type {string} */ key) => copy(CONFIG[key]));
swaps.swap(configStore, 'getConfigFresh', async (/** @type {string} */ key) => copy(CONFIG[key]));

const api = h.serve('/', require('./orgAzureConfig'));

test.before(() => db.settle());
test.after(async () => { swaps.restore(); await api.close(); });

const ANN = { id: 'ann', role: 'user', organizationId: 'orgA' };
const BEN = { id: 'ben', role: 'user', organizationId: 'orgA' };
const ROOT = { id: 'root', role: 'admin' };

/** @param {Record<string, unknown>} user @param {string} orgId */
const read = (user, orgId) => api.call('GET', `/${orgId}/sync-groups/status`, { user });

test('the organisation admin reads their own organisation\'s group sync', async () => {
    const res = await read(ANN, 'orgA');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, {
        directoryConfigured: true,
        status: { lastSyncAt: '2026-11-10T09:00:00.000Z', lastSyncResult: 'success', syncedGroups: 3, syncedUsers: 8, errorCount: 0 },
        settings: { destructiveSync: false, autoActivateUsers: true, periodicSync: true, syncIntervalHours: 12 },
    });
});

test('the answer carries no value of the directory connection', async () => {
    const res = await read(ANN, 'orgA');
    for (const value of [TENANT, CLIENT_ID, CLIENT_SECRET, 'https://', 'configuredBy']) {
        assert.ok(!res.text.includes(value), `${value} leaked: ${res.text}`);
    }
});

test('the same admin is refused for an organisation where they are only a group member', async () => {
    const res = await read(ANN, 'orgB');
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.directoryConfigured, undefined);
    assert.strictEqual(res.body.status, undefined);
});

test('a plain member of the organisation is refused', async () => {
    const res = await read(BEN, 'orgA');
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body.status, undefined);
});

test('a platform admin reads it too', async () => {
    const res = await read(ROOT, 'orgA');
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.directoryConfigured, true);
});

test('without a session it is refused before anything is read', async () => {
    const res = await api.call('GET', '/orgA/sync-groups/status', { user: null });
    assert.strictEqual(res.status, 401, res.text);
});
