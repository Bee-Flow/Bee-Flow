/**
 * Unit tests for enabledAppsOverride — the per-cowork app list.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/integrationTools.coworkApps.test.js
 *
 * INVARIANT under test: enabledAppsOverride stands in for the per-user
 * enabled-apps preference and NOTHING else. It can narrow what one unattended
 * run may touch — the whole point, since a cowork fires hours later against
 * credentials nobody is watching — but it must never widen an org grant and
 * never skip a credential check.
 *
 * DB-free: same monkeypatch harness as integrationTools.extraApps.test.js.
 *
 * NOT covered here, deliberately: the AUTO_ENABLED_APPS carve-out (web search
 * and friends stay on even when they are absent from a saved list — they are
 * not in the picker, so they are never in one). The override replaces the very
 * same `userEnabledApps` variable the stored preference feeds, so it goes
 * through that carve-out unchanged; proving it again would need a search
 * provider this harness has no credentials for.
 */

const assert = require('assert');

const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

const configStore = require('../../stores/configStore');
// The workspace-wide preference has BOTH apps on; the per-item list is what
// narrows a given run below it.
let userEnabledApps = ['gmail', 'fireflies'];
let firefliesSecret = 'ff-key';
configStore.getConfig = async (key) => {
    if (key.startsWith('enabled_apps_user_')) return userEnabledApps;
    return null;
};
configStore.getSecret = async (key) => {
    if (key.startsWith('fireflies_api_key_user_')) return firefliesSecret;
    return null;
};

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;
userStore.getOrgEnabledIntegrations = async () => ['gmail', 'fireflies'];

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

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

const session = { user: { id: 'u1', role: 'user' } };
const hasFireflies = (r) => r.tools.some(t => t.function.name.startsWith('fireflies_'));

const run = async () => {
    ent.resolveEntitlements = async () => snap({ integration: ['gmail', 'fireflies', 'agent-search'] });

    // (a) no override → the workspace-wide preference decides, as it always did
    let res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(hasFireflies(res), 'baseline: workspace list has fireflies on');
    console.log('✓ without an override the user preference still decides');

    // (b) null override behaves exactly like absent — this is what every
    //     prompt task and every cowork that never opened the picker sends
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, enabledAppsOverride: null });
    assert.ok(hasFireflies(res), 'null override must not narrow anything');
    console.log('✓ a null override changes nothing');

    // (c) the per-item list narrows below the workspace preference
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, enabledAppsOverride: ['gmail'] });
    assert.ok(!hasFireflies(res), 'an item that may not use fireflies gets no fireflies tools');
    console.log('✓ the per-item list narrows the run');

    // (d) an EMPTY list is a real answer: this one may touch nothing
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, enabledAppsOverride: [] });
    assert.ok(!hasFireflies(res), 'empty list withholds every credentialed app');
    console.log('✓ an empty list is honoured, not treated as "unset"');

    // (f) PRIVACY-CRITICAL: the override narrows, it never widens. The user's
    //     preference is replaced, but the org grant below it is not.
    ent.resolveEntitlements = async () => snap({ integration: ['gmail'] });
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, enabledAppsOverride: ['fireflies'] });
    assert.ok(!hasFireflies(res), 'no entitlement: the per-item list must NOT widen the org grant');
    console.log('✓ the override never widens entitlements');

    // (g) …and it does not skip credential checks either
    ent.resolveEntitlements = async () => snap({ integration: ['gmail', 'fireflies', 'agent-search'] });
    firefliesSecret = null;
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, enabledAppsOverride: ['fireflies'] });
    assert.ok(!hasFireflies(res), 'no credential: the per-item list must NOT skip credential checks');
    firefliesSecret = 'ff-key';
    console.log('✓ the override never skips credential checks');

    console.log('\nALL PER-COWORK APP-LIST TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
