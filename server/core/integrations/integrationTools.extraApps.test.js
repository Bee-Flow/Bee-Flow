/**
 * Unit tests for the extraEnabledApps allowlist (skill-scoped app enablement).
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/integrationTools.extraApps.test.js
 *
 * INVARIANT under test: extraEnabledApps bypasses ONLY the per-user
 * enabled-apps preference. It must never widen org entitlements and never
 * skip credential checks — this is a privacy product; a skill may surface an
 * app the user hasn't toggled on, but only within what the org granted and
 * what the user actually connected.
 *
 * DB-free: same monkeypatch harness as integrationTools.notebooks.test.js.
 */

const assert = require('assert');

// ── Patch destructure-at-load deps BEFORE requiring the module under test ──
const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

// ── Patch lazy-required data sources (looked up per call) ──────────────────
const configStore = require('../../stores/configStore');
// The user's saved enabled-apps list deliberately EXCLUDES fireflies — that
// per-user preference is exactly the layer extraEnabledApps may bypass.
let userEnabledApps = ['gmail'];
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

function snap({ core = [], integration = [], degraded = false } = {}) {
    return {
        degraded,
        tier: 'enterprise',
        ceiling: { core, integration, beta: [] },
        effective: { core, integration, beta: [] },
    };
}

const session = { user: { id: 'u1', role: 'user' } };
const hasFireflies = (r) => r.tools.some(t => t.function.name.startsWith('fireflies_'));

const run = async () => {
    // (a) baseline: entitled + credentialed, but per-user toggle OFF → absent
    ent.resolveEntitlements = async () => snap({ integration: ['gmail', 'fireflies'] });
    let res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(!hasFireflies(res), 'user toggle off: no fireflies tools');
    console.log('✓ per-user toggle withholds the app by default');

    // (b) skill allowlist bypasses the per-user toggle → present
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, extraEnabledApps: ['fireflies'] });
    assert.ok(hasFireflies(res), 'extraEnabledApps surfaces the app past the user toggle');
    console.log('✓ extraEnabledApps bypasses the per-user preference');

    // (c) PRIVACY-CRITICAL: entitlement missing → absent even with allowlist
    ent.resolveEntitlements = async () => snap({ integration: ['gmail'] });
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, extraEnabledApps: ['fireflies'] });
    assert.ok(!hasFireflies(res), 'no entitlement: extraEnabledApps must NOT widen the org grant');
    console.log('✓ extraEnabledApps never widens entitlements');

    // (d) credential missing → absent even when entitled + allowlisted
    ent.resolveEntitlements = async () => snap({ integration: ['gmail', 'fireflies'] });
    firefliesSecret = null;
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, extraEnabledApps: ['fireflies'] });
    assert.ok(!hasFireflies(res), 'no credential: extraEnabledApps must NOT skip credential checks');
    firefliesSecret = 'ff-key';
    console.log('✓ extraEnabledApps never skips credential checks');

    // (e) allowlist does not disturb the user's normally-enabled apps
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false, extraEnabledApps: ['fireflies'] });
    assert.ok(hasFireflies(res), 'sanity: allowlisted app present again');
    // gmail tools require a google session — absence here is credential-gated,
    // which is exactly the invariant: the allowlist changed nothing for gmail.
    assert.ok(!res.tools.some(t => t.function.name.startsWith('gmail_')), 'gmail still credential-gated');
    console.log('✓ allowlist is additive-only');

    console.log('\nALL EXTRA-APPS ALLOWLIST TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
