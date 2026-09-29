/**
 * The org-admin's Nextcloud toggles: enforceable, without taking Nextcloud
 * away from anyone who never touched them.
 *
 * Two failure modes, and this suite exists because avoiding one nearly
 * caused the other.
 *
 * The original bug: NC capabilities bypassed the org-grant list entirely, so
 * routes/admin/ncIntegrations.js wrote the NC slice of
 * organizations.enabledIntegrations and NOTHING read it. Turning "Nextcloud
 * Talk" off org-wide moved the checkbox, wrote the audit event, and gated
 * nothing.
 *
 * The near-miss: enforcing that column instead. An array carrying no NC ids
 * is ambiguous — "the admin unticked everything" and "this array exists for
 * unrelated reasons and Nextcloud was never configured" are indistinguishable
 * — so enforcing it would have silently removed Nextcloud from organisations
 * that never asked, on upgrade. An empty legacy list simply cannot express
 * "all off".
 *
 * The resolution: the toggles write org_nc_scope_<orgId>, which records a
 * mode per integration, so "off" is stated rather than inferred from absence.
 * Entitlements keeps its unconditional NC bypass (nobody loses access on
 * deploy) and ncScopeGuard enforces the ceiling, where no doc means no
 * restriction.
 *
 * Run: node --test server/core/entitlements/ncOrgToggles.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let org = null;
const configs = new Map();
stub('../../stores/userStore', {
    getOrganization: async () => org,
    getOrgEnabledIntegrations: async () => [],
    getOrgGrantedCapabilities: async () => [],
    getAllUsers: async () => [],
});
stub('../../stores/configStore', {
    getConfig: async (k) => configs.get(k) ?? null,
    setConfig: async (k, v) => { configs.set(k, v); },
    deleteConfig: async (k) => { configs.delete(k); },
    getSecret: async () => null,
});
stub('../../stores/guardrailEventStore', { logGuardrailEvent: async () => {} });

const entitlements = require('./entitlements');
const ncScope = require('../integrations/ncScope');
const { NC_INTEGRATION_IDS } = require('../integrations/ncIntegrationCatalog');

const ORG = 'org-1';
const CEILING = { integration: [...NC_INTEGRATION_IDS, 'gmail'], core: [], beta: [] };

async function grantedIntegrations() {
    const g = await entitlements._buildOrgGrant({ mode: 'cloud', orgId: ORG, ceiling: CEILING });
    return g.integration;
}

async function effectiveScope() {
    return await ncScope.resolveNcScope({ orgId: ORG });
}

beforeEach(() => { org = { id: ORG }; configs.clear(); });

// ── Nobody loses access on deploy ───────────────────────────────────────────

test('a legacy array carrying no NC ids does NOT restrict anything', async () => {
    // THE REGRESSION THIS FILE GUARDS. Enforcing this column would have taken
    // Nextcloud away from every org whose list exists for unrelated reasons.
    org.enabledIntegrations = ['gmail'];
    const granted = await grantedIntegrations();
    for (const id of NC_INTEGRATION_IDS) {
        assert.ok(granted.has(id), `${id} must survive an unrelated legacy list`);
    }
    const scope = await effectiveScope();
    for (const id of NC_INTEGRATION_IDS) assert.equal(scope[id].mode, 'all');
});

test('a legacy array that DID list NC ids still restricts nothing until re-saved', async () => {
    // Such an org configured the panel back when it was a no-op. Applying it
    // retroactively would be the same unannounced removal, just for a
    // different set of orgs. Their next save takes effect; nothing before it.
    org.enabledIntegrations = ['nextcloud', 'nextcloud-calendar'];
    const scope = await effectiveScope();
    assert.equal(scope['nextcloud-talk'].mode, 'all');
});

test('an org that never opened the panel is unrestricted', async () => {
    org.enabledIntegrations = null;
    const granted = await grantedIntegrations();
    for (const id of NC_INTEGRATION_IDS) assert.ok(granted.has(id));
    assert.equal(await ncScope.getOrgScopeDoc(ORG), null, 'no doc means no opinion');
});

// ── …but the toggles genuinely bite once used ───────────────────────────────

test('saving the panel makes the unticked integrations off', async () => {
    await ncScope.setOrgEnabledIntegrations(ORG, ['nextcloud', 'nextcloud-calendar'], { updatedBy: 'admin-1' });
    const scope = await effectiveScope();
    assert.equal(scope['nextcloud'].mode, 'all');
    assert.equal(scope['nextcloud-calendar'].mode, 'all');
    assert.equal(scope['nextcloud-talk'].mode, 'off', 'this was the no-op the whole exercise started from');
    assert.equal(scope['nextcloud-mail'].mode, 'off');
});

test('unticking everything is expressible — the thing an empty legacy list could never say', async () => {
    await ncScope.setOrgEnabledIntegrations(ORG, [], { updatedBy: 'admin-1' });
    const scope = await effectiveScope();
    for (const id of NC_INTEGRATION_IDS) {
        assert.equal(scope[id].mode, 'off', `${id} must be off when the admin unticks everything`);
    }
});

test('re-ticking restores access', async () => {
    await ncScope.setOrgEnabledIntegrations(ORG, [], { updatedBy: 'admin-1' });
    await ncScope.setOrgEnabledIntegrations(ORG, NC_INTEGRATION_IDS, { updatedBy: 'admin-1' });
    const scope = await effectiveScope();
    for (const id of NC_INTEGRATION_IDS) assert.equal(scope[id].mode, 'all');
});

test('the org ceiling still beats a broader per-user choice', async () => {
    await ncScope.setOrgEnabledIntegrations(ORG, ['nextcloud'], { updatedBy: 'admin-1' });
    configs.set(`user_nc_scope_u-1`, { v: 1, integrations: { 'nextcloud-talk': { mode: 'all' } } });
    const scope = await ncScope.resolveNcScope({ orgId: ORG, userId: 'u-1' });
    assert.equal(scope['nextcloud-talk'].mode, 'off',
        'a user cannot re-grant themselves what the org turned off');
});

test('non-NC integrations are untouched by any of this', async () => {
    await ncScope.setOrgEnabledIntegrations(ORG, [], { updatedBy: 'admin-1' });
    org.enabledIntegrations = ['gmail'];
    const granted = await grantedIntegrations();
    // gmail is governed by the org grant list, not by the NC bypass — the
    // point is only that the NC changes did not disturb it either way.
    assert.equal(granted.has('gmail'), false);
});
