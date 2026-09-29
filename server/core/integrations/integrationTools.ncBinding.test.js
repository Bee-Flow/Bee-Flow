/**
 * NC tool availability for DB-bound users on standalone sessions.
 *
 * Regression: the Nextcloud tool block gated on the SESSION shape
 * (provider === 'nextcloud_connector' || connectorOrgId), so an org admin of
 * a Nextcloud org who logged in at beeflow.nl in a normal browser — a session
 * with none of the connector extras — was never offered a single NC tool,
 * and "list my files" failed before any auth resolution even ran. The binding
 * is org-level (auth/ncAudience.js): it must open the gate from the DB row.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node --test server/core/integrations/integrationTools.ncBinding.test.js
 * DB-free: same monkeypatch harness as integrationTools.extraApps.test.js.
 */

const assert = require('assert');

// ── Patch destructure-at-load deps BEFORE requiring the module under test ──
const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

// ── Patch lazy-required data sources (looked up per call) ──────────────────
const configStore = require('../../stores/configStore');
configStore.getConfig = async (key) => {
    if (key === 'oauth') return {}; // no org-wide nextcloudUrl — connector binding is the only gate
    if (key.startsWith('enabled_apps_user_')) return null;
    return null;
};
configStore.getSecret = async () => null;

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'org-nc', groups: [], role: 'user', nc_uid: 'tom' });
userStore.getOrganization = async () => ({ id: 'org-nc', enabledIntegrations: null, nc_instance_id: 'nc-host:x' });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;
userStore.getOrgEnabledIntegrations = async () => null;

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

const ncClient = require('../../integrations/nextcloudClient');
const ent = require('../entitlements/entitlements');
const { getIntegrationTools } = require('./integrationTools');

function snap({ integration = [] } = {}) {
    return {
        degraded: false,
        tier: 'enterprise',
        ceiling: { core: [], integration, beta: [] },
        effective: { core: [], integration, beta: [] },
    };
}

const NC_IDS = ['nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck',
    'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes',
    'nextcloud-mail', 'nextcloud-activity', 'nextcloud-tables', 'nextcloud-forms',
    'nextcloud-teams', 'nextcloud-status'];

// The standalone login shape (auth/loginRoutes.js): no provider, no
// connectorOrgId, no organizationId even — just the minimal user.
const standaloneSession = { user: { id: 'u1', displayName: 'Tom', role: 'user' } };

const hasNcFiles = (r) => r.tools.some(t => t.function.name === 'nextcloud_list_files');

const run = async () => {
    ent.resolveEntitlements = async () => snap({ integration: NC_IDS });

    // (a) DB-bound user on a standalone session → NC tools offered
    ncClient.resolveNcBinding = async (session, userId) => {
        assert.equal(userId, 'u1', 'gate must resolve the binding for the requesting user');
        return { orgId: 'org-nc', ncUid: 'tom' };
    };
    let res = await getIntegrationTools({ userId: 'u1', session: standaloneSession, isAdmin: false });
    assert.ok(hasNcFiles(res), 'NC-bound row must open the NC tool gate from a standalone session');
    console.log('✓ standalone session of an NC-bound user is offered NC tools');

    // (b) no binding, no URL, no creds → NC tools absent (gate must not widen)
    ncClient.resolveNcBinding = async () => null;
    res = await getIntegrationTools({ userId: 'u1', session: standaloneSession, isAdmin: false });
    assert.ok(!hasNcFiles(res), 'no binding: the DB-backed gate must not fabricate NC access');
    console.log('✓ unbound user on a standalone session gets no NC tools');

    // (c) connector session shape still opens the gate without a DB lookup
    ncClient.resolveNcBinding = async () => { throw new Error('fast path must not consult the DB resolver'); };
    const connectorSession = { user: { id: 'u1', provider: 'nextcloud_connector' }, connectorOrgId: 'org-nc' };
    res = await getIntegrationTools({ userId: 'u1', session: connectorSession, isAdmin: false });
    assert.ok(hasNcFiles(res), 'connector session shape must keep its zero-lookup fast path');
    console.log('✓ connector-session fast path intact');

    console.log('\nALL NC-BINDING GATE TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
