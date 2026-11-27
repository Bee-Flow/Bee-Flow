'use strict';
/**
 * The integration availability of one organisation
 * (usecases/integrations/orgIntegrationAvailability.mts), over the real stores
 * on a real Postgres (PGlite): the organisation row and its Nextcloud binding,
 * the instance config and secrets, the Nextcloud scope document and the Azure
 * sync binding are all written and read for real; the GitHub sync config comes
 * from a stand-in under the name the module "int_saas" provides.
 *
 * What is passed in: the auth config (the SSO providers, which the auth config
 * store keeps encrypted elsewhere), whether an image model exists, the module
 * states and, where a test pins the plan, the entitlement snapshot. One test
 * runs the real resolver end to end.
 *
 * Run: cd server && node --test usecases/integrations/orgIntegrationAvailability.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'avail-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'avail-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const ORG_PLAIN = 'org-avail-plain';
const ORG_NC = 'org-avail-nc';
const ORG_LEGACY = 'org-avail-legacy';
const ORG_PLAN = 'org-avail-plan';
const ORG_NAME = 'Availability Test Organisation';
const NC_INSTANCE = 'nc-inst-avail-1';
const AZURE_TENANT = '11111111-2222-4333-8444-555555555555';

/** The per-user families: nothing to set up on the server, a key per person. */
const PER_USER = ['fireflies', 'nmbrs', 'afas-profit', 'frappe-crm', 'firebird', 'vplan', 'signrequest', 'youtrack', 'gamma'];

let userStore;
let configStore;
let availability;

const ALL_CAPS = {
    core: ['projects'],
    // mcp_marketplace is a licence string, never a capability row: the real resolver never lists it.
    beta: ['meeting_notes', 'learning_center', 'automations'],
    integration: [
        'gmail', 'google-calendar', 'google-drive', 'outlook', 'ms-calendar', 'github', 'n8n', 'maps', 'image-gen',
        'linkedin', 'withings', 'transcription', ...PER_USER,
    ],
};
const snapOf = (ceiling, orgAvailable = ceiling) => async () => ({ mode: 'cloud', ceiling, orgAvailable, orgEnabled: { core: [], beta: [], integration: [] } });

const SSO_BOTH = { providers: { google: { clientId: 'g-id', clientSecret: 'g-secret' }, microsoft: { clientId: 'm-id', clientSecret: 'm-secret', tenantId: AZURE_TENANT } } };

/** Everything configured and on; a test overrides what it is about. */
function deps(over = {}) {
    return {
        loadAuthConfig: async () => SSO_BOTH,
        imageGenerationAvailable: async () => true,
        webSearchAvailable: async () => true,
        isModuleActive: async () => true,
        hasLicenseFeature: async () => true,
        snapshot: snapOf(ALL_CAPS),
        env: {},
        ...over,
    };
}

before(async () => {
    userStore = require('../../stores/userStore');
    configStore = require('../../stores/configStore');
    await userStore.initDB();
    for (const id of [ORG_PLAIN, ORG_NC, ORG_LEGACY, ORG_PLAN]) await userStore.createOrganization({ id, name: ORG_NAME, email: 'office@avail.test' }, { autoGrantTrial: false });
    await userStore.updateOrganization(ORG_NC, { ncInstanceId: NC_INSTANCE, ncBaseUrl: 'https://cloud.avail.test', ncAdminUid: 'nc-admin' });
    await userStore.updateOrganization(ORG_LEGACY, { enabledIntegrations: ['gmail', 'github'] });
    await configStore.setSecret('google_maps_api_key', 'maps-value');
    // A cloud organisation on a plan (the resolver's ceiling comes from it), whose access menu holds Gmail only.
    const plan = await userStore.createPlan({ name: 'Availability plan', tier: 'pro', allowed_features: [] });
    await userStore.setOrgSubscription(ORG_PLAN, { plan_id: plan.id, status: 'active' });
    await userStore.setOrgAvailableCapabilities(ORG_PLAN, ['gmail']);
    availability = require('./orgIntegrationAvailability.mts');
}, { timeout: 120_000 });

/**
 * createOrganization pre-generates each org's webhook signing key in a
 * setImmediate; let those writes land before the database closes.
 */
async function settleOrgBackgroundWork(ids) {
    for (let i = 0; i < 100; i++) {
        const keys = await Promise.all(ids.map(id => configStore.getSecretFresh(`org_webhook_signing_key_${id}`)));
        if (keys.every(Boolean)) return;
        await new Promise(resolve => setImmediate(resolve));
    }
}

after(async () => {
    await settleOrgBackgroundWork([ORG_PLAIN, ORG_NC, ORG_LEGACY, ORG_PLAN]);
    await closePg();
});

test('everything set up: every family is available except Nextcloud, which an unbound org lacks', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, { organizationId: ORG_PLAIN }, deps());
    assert.equal(av.orgId, ORG_PLAIN);
    assert.equal(av.homeOrg, true);
    assert.equal(av.degraded, false);
    for (const id of availability.FAMILY_IDS) {
        if (id === 'nextcloud') continue;
        assert.deepEqual(av.families[id], { serverConfigured: true, inCeiling: true, available: true }, id);
    }
    assert.deepEqual(av.families.nextcloud, { serverConfigured: true, inCeiling: true, available: false, reason: 'not_bound' });
    assert.deepEqual(av.nextcloud, { bound: false, apps: [], pairingAvailable: true });
    assert.deepEqual(av.signIn, { password: true, google: true, microsoft: true, ssoLicensed: true });
});

test('a platform admin looking at another organisation: homeOrg is false', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, { organizationId: ORG_NC }, deps());
    assert.equal(av.homeOrg, false);
    const none = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, { organizationId: null }, deps());
    assert.equal(none.homeOrg, false);
});

test('a Nextcloud-bound organisation: bound, its instance id, every app until the scope switches one off', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_NC, {}, deps());
    assert.equal(av.families.nextcloud.available, true);
    assert.equal(av.nextcloud.bound, true);
    assert.equal(av.nextcloud.instanceId, NC_INSTANCE);
    assert.equal(av.nextcloud.pairingAvailable, false);
    assert.ok(av.nextcloud.apps.includes('nextcloud-talk'));
    assert.equal(av.integrations['nextcloud-talk'].available, true);

    await require('../../core/integrations/ncScope').saveOrgScope(ORG_NC, { integrations: { 'nextcloud-talk': { mode: 'off' } } });
    const after = await availability.resolveOrgIntegrationAvailability(ORG_NC, {}, deps());
    assert.ok(!after.nextcloud.apps.includes('nextcloud-talk'));
    assert.ok(after.nextcloud.apps.includes('nextcloud'));
    assert.equal(after.integrations['nextcloud-talk'].available, false);
    assert.equal(after.integrations['nextcloud-talk'].reason, 'not_granted_to_org');
    // An unbound org reports none of the Nextcloud apps as available.
    const plain = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
    assert.equal(plain.integrations.nextcloud.available, false);
    assert.equal(plain.integrations.nextcloud.reason, 'not_bound');
});

test('Google not set up on this server: the Google family and its apps are not configured, sign-in offers no Google', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        loadAuthConfig: async () => ({ providers: { microsoft: SSO_BOTH.providers.microsoft } }),
    }));
    assert.deepEqual(av.families.google, { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' });
    assert.equal(av.families.microsoft.available, true);
    assert.equal(av.signIn.google, false);
    assert.deepEqual(av.integrations.gmail, { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' });
    // An auth config that cannot be read counts as nothing set up.
    const broken = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({ loadAuthConfig: async () => { throw new Error('store down'); } }));
    assert.equal(broken.families.google.reason, 'not_configured');
    assert.equal(broken.families.microsoft.reason, 'not_configured');
});

test('not in the plan versus not granted to the organisation', async () => {
    const plan = { core: [], beta: [], integration: ['maps', 'gmail'] };
    const menu = { core: [], beta: [], integration: ['gmail'] };
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        snapshot: snapOf(plan, menu),
        hasLicenseFeature: async (_orgId, feature) => feature !== 'mcp_marketplace',
    }));
    assert.equal(av.families.maps.reason, 'not_granted_to_org');
    assert.equal(av.families.github.reason, 'not_in_plan');
    assert.equal(av.families.mcp.reason, 'not_in_plan');
    assert.equal(av.families.google.available, true, 'one Google app in the ceiling is enough for the family');
    assert.equal(av.integrations.maps.inCeiling, false);
    assert.equal(av.integrations.maps.reason, 'not_granted_to_org');
    assert.equal(av.integrations.github.reason, 'not_in_plan');
});

test('the MCP family follows the mcp_marketplace licence of the chosen organisation, which no snapshot carries', async () => {
    const asked = [];
    const licensed = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        hasLicenseFeature: async (orgId, feature) => { asked.push([orgId, feature]); return true; },
    }));
    assert.deepEqual(licensed.families.mcp, { serverConfigured: true, inCeiling: true, available: true });
    assert.ok(asked.some(([o, f]) => o === ORG_PLAIN && f === 'mcp_marketplace'), 'asked for the chosen org');
    const unlicensed = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        hasLicenseFeature: async (_orgId, feature) => feature !== 'mcp_marketplace',
    }));
    assert.deepEqual(unlicensed.families.mcp, { serverConfigured: true, inCeiling: false, available: false, reason: 'not_in_plan' });
    const unreadable = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        hasLicenseFeature: async () => { throw new Error('licence store down'); },
    }));
    assert.equal(unreadable.families.mcp.available, false, 'a licence that cannot be read counts as absent');
});

test('the legacy per-org allow-list narrows the integrations', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_LEGACY, {}, deps());
    assert.equal(av.families.github.available, true);
    assert.equal(av.families.n8n.reason, 'not_granted_to_org');
    assert.equal(av.integrations['google-drive'].inCeiling, false);
    assert.equal(av.integrations.gmail.inCeiling, true);
    // Core and beta capabilities are not on that list.
    assert.equal(av.families.projects.available, true);
});

test('a module that is off, the meeting-notes switch and the projects flag', async () => {
    const off = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({
        isModuleActive: async (id) => id !== 'learning',
        env: { ENABLE_MEETING_NOTES: 'false' },
    }));
    assert.equal(off.families.learningCenter.reason, 'module_off');
    assert.equal(off.families.meetingNotes.reason, 'module_off');
    assert.equal(off.families.automations.available, true);

    await configStore.setConfig('feature_projects_enabled', false);
    try {
        const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
        assert.equal(av.families.projects.reason, 'module_off');
    } finally {
        await configStore.setConfig('feature_projects_enabled', true);
    }
});

test('image generation and Maps follow what the server has set up', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({ imageGenerationAvailable: async () => false }));
    assert.equal(av.families.imageGen.reason, 'not_configured');
    assert.equal(av.families.maps.available, true, 'the Maps key is stored');
    assert.equal(av.integrations.linkedin.serverConfigured, false);
    const withEnv = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps({ env: { LINKEDIN_CLIENT_ID: 'x', LINKEDIN_CLIENT_SECRET: 'y' } }));
    assert.equal(withEnv.integrations.linkedin.serverConfigured, true);
    // Keyed services follow the instance key the chat tool gate reads.
    assert.equal(av.integrations.elevenlabs.serverConfigured, false);
    assert.equal(av.integrations['video-gen'].serverConfigured, false);
    const noSearch = await availability.serverConfiguredMap(['agent-search'], deps({ webSearchAvailable: async () => false }));
    assert.deepEqual(noSearch, { 'agent-search': { serverConfigured: false, reason: 'not_configured' } });
    await configStore.setSecret('elevenlabs_api_key', 'el-value');
    await configStore.setSecret('google_api_key', 'gk-value');
    try {
        const keyed = await availability.serverConfiguredMap(['elevenlabs', 'video-gen', 'agent-search'], deps());
        assert.deepEqual(keyed, { elevenlabs: { serverConfigured: true }, 'video-gen': { serverConfigured: true }, 'agent-search': { serverConfigured: true } });
    } finally {
        await configStore.setSecret('elevenlabs_api_key', '');
        await configStore.setSecret('google_api_key', '');
    }
});

test('the per-user integrations are in the record and need nothing on the server', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
    for (const id of PER_USER) {
        assert.deepEqual(av.integrations[id], { serverConfigured: true, inCeiling: true, available: true }, id);
    }
    const map = await availability.serverConfiguredMap(undefined, deps());
    for (const id of PER_USER) assert.deepEqual(map[id], { serverConfigured: true }, id);
    assert.deepEqual(map['image-gen'], { serverConfigured: true });
    const narrowed = await availability.serverConfiguredMap(['gmail', 'fireflies'], deps({ loadAuthConfig: async () => ({}) }));
    assert.deepEqual(narrowed, { gmail: { serverConfigured: false, reason: 'not_configured' }, fireflies: { serverConfigured: true } });
});

test('withServerConfigured adds a flag per integration row of a matrix payload', async () => {
    const payload = { orgId: ORG_PLAIN, capabilities: [{ id: 'gmail', kind: 'integration' }, { id: 'projects', kind: 'core' }, { id: 'maps', kind: 'integration' }] };
    const out = await availability.withServerConfigured(payload, deps({ loadAuthConfig: async () => ({}) }));
    assert.deepEqual(out.serverConfigured, { gmail: { serverConfigured: false, reason: 'not_configured' }, maps: { serverConfigured: true } });
    assert.equal(out.capabilities, payload.capabilities);
});

test('GitHub sync and the Microsoft directory are read for the chosen organisation', async () => {
    // The GitHub sync config is asked of the module "int_saas" by name: a stand-in store under that
    // name, so this holds with the module present or absent.
    const featureModules = require('../../core/featureModules');
    const realGetter = featureModules._featureModuleGetter('stores/githubSyncStore');
    /** @type {Map<string, { repoOwner: string, repoName: string }>} */
    const synced = new Map();
    featureModules.registerFeatureModules({ 'stores/githubSyncStore': () => /** @type {any} */ ({ getOrgSyncConfig: async (/** @type {string} */ id) => synced.get(id) || null }) });
    try {
        const before = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
        assert.equal(before.github.syncConfigured, false);
        assert.equal(before.microsoft.directoryConnected, false);

        synced.set(ORG_PLAIN, { repoOwner: 'owner', repoName: 'repo' });
        await configStore.setConfig('azure_group_sync_binding', { syncOrganizationId: ORG_PLAIN, syncTenantId: AZURE_TENANT });
        const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
        assert.equal(av.github.syncConfigured, true);
        assert.equal(av.microsoft.directoryConnected, true);
        const other = await availability.resolveOrgIntegrationAvailability(ORG_NC, {}, deps());
        assert.equal(other.github.syncConfigured, false);
        assert.equal(other.microsoft.directoryConnected, false, 'the directory is bound to another organisation');
    } finally {
        if (realGetter) featureModules.registerFeatureModules({ 'stores/githubSyncStore': realGetter });
        else featureModules._clearFeatureModulesForTests('stores/githubSyncStore');
    }
});

test('without the module "int_saas" GitHub sync reads as not configured', async () => {
    const featureModules = require('../../core/featureModules');
    const realGetter = featureModules._featureModuleGetter('stores/githubSyncStore');
    featureModules._clearFeatureModulesForTests('stores/githubSyncStore');
    try {
        const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
        assert.equal(av.github.syncConfigured, false);
    } finally {
        if (realGetter) featureModules.registerFeatureModules({ 'stores/githubSyncStore': realGetter });
    }
});

test('an organisation that does not exist is a 404', async () => {
    await assert.rejects(
        availability.resolveOrgIntegrationAvailability('org-avail-missing', {}, deps()),
        (err) => err.status === 404,
    );
});

test('the real entitlement resolver: the plan is the ceiling, the org access menu narrows it', async () => {
    const { snapshot: _pinned, ...real } = deps();
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAN, {}, real);
    assert.equal(av.degraded, false);
    assert.equal(av.integrations.gmail.inCeiling, true);
    assert.equal(av.integrations['google-drive'].inCeiling, false);
    assert.equal(av.families.google.available, true);
    assert.equal(av.families.maps.reason, 'not_granted_to_org', 'Maps is in the plan, not in the menu');
    // An organisation without a plan has no integration in its ceiling.
    const bare = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, real);
    assert.equal(bare.families.github.reason, 'not_in_plan');
});

test('the answer carries booleans and ids only: no name, address, e-mail or configuration value', async () => {
    const av = await availability.resolveOrgIntegrationAvailability(ORG_NC, { organizationId: ORG_NC }, deps());
    const text = JSON.stringify(av);
    for (const leak of [ORG_NAME, 'office@avail.test', 'cloud.avail.test', 'nc-admin', 'maps-value', 'g-secret', 'm-secret', 'g-id', 'm-id', AZURE_TENANT]) {
        assert.ok(!text.includes(leak), `the answer must not carry ${leak}`);
    }
    const ID = /^[a-z0-9_:.-]+$/i;
    (function walk(v, at) {
        if (typeof v === 'boolean') return;
        if (typeof v === 'string') { assert.match(v, ID, at); return; }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
        assert.ok(v && typeof v === 'object', `${at} is a boolean, an id, a list or a record`);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    })(av, 'answer');
    assert.deepEqual(Object.keys(av).sort(), ['degraded', 'families', 'github', 'homeOrg', 'integrations', 'microsoft', 'nextcloud', 'orgId', 'signIn']);
});
