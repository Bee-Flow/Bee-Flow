'use strict';

/**
 * Characterisation (golden) test for core/integrations/integrationTools.js.
 *
 * Pins, for a handful of representative users, EXACTLY what the module
 * returns today: the ordered tool names of getIntegrationTools (the order is
 * what the model sees, so it is part of the behaviour), the order of the
 * configStore lookups it makes, the system-prompt hint buildToolHint builds
 * from that list, and the answers of the design-time gate
 * (getUserPermittedApps / isIntegrationPermittedForUser /
 * availableMcpServerIds). Written before the file was split into
 * toolHint.js, userAppGate.js, integrationAppPolicy.js and
 * externalToolInjection.js, so the split can prove it moved code and changed
 * nothing.
 *
 * DB-free: the same monkeypatch harness as integrationTools.extraApps.test.js
 * (destructure-at-load deps patched before the module loads, lazy-required
 * data sources patched on their module objects).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/integrations/integrationTools.characterisation.test.js
 *
 * Run: cd server && node --test core/integrations/integrationTools.characterisation.test.js
 */

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
delete process.env.INTEGRATION_CONNECTION_LENDING_ENABLED;
delete process.env.SEARCH_SERVICE_URL;
process.env.BROWSER_WS_ENDPOINT = 'ws://browser.test';

const GOLDEN = path.join(__dirname, 'integrationTools.characterisation.golden.json');

const fnTool = (name, extra = {}) => ({
    type: 'function',
    function: { name, description: `desc ${name}`, parameters: { type: 'object', properties: {} } },
    ...extra,
});

// ── Scenario state ─────────────────────────────────────────────────────────
const S = {};
function reset(over = {}) {
    Object.assign(S, {
        config: {},
        secrets: {},
        user: { id: 'u1', organizationId: 'o1', groups: ['g1'], role: 'user' },
        org: { id: 'o1', enabledIntegrations: null },
        groups: [{ id: 'g1', disabled_integrations: [] }],
        orgActive: null,
        appPassword: null,
        snapshot: null,
        hasCap: true,
        beta: false,
        webpageAccess: false,
        ncBinding: null,
        ncScope: {},
        withings: null,
        configKeys: [],
    }, over);
}
reset();

// ── Destructure-at-load deps ───────────────────────────────────────────────
const permissions = require('../../auth/permissions');
permissions.hasPermission = async (_u, perm) => perm !== 'modify_n8n_workflows' || !!S.canModifyN8n;
const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async (_u, f) => f === 'webpages' && S.beta;
const n8nTools = require('../../integrations/n8nTools');
n8nTools.buildN8nTools = async () => [fnTool('n8n_run_invoice_flow', { _n8n: { workflowId: 'wf-1' } })];

// ── Lazy data sources ──────────────────────────────────────────────────────
const configStore = require('../../stores/configStore');
configStore.getConfig = async (k) => { S.configKeys.push(`config:${k}`); return S.config[k] ?? null; };
configStore.getSecret = async (k) => { S.configKeys.push(`secret:${k}`); return S.secrets[k] ?? null; };

const userStore = require('../../stores/userStore');
userStore.getUser = async () => S.user;
userStore.getOrganization = async () => S.org;
userStore.getAllGroups = async () => S.groups;
userStore.getAppPassword = async () => S.appPassword;
userStore.getOrgEnabledIntegrations = async () => S.orgActive;

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => S.snapshot;
ent.hasCapability = async () => S.hasCap;
ent.snapshotHas = (snap, id) => !!snap && !snap.degraded && (snap.effective.core || []).includes(id);

const mcpManager = require('../mcpManager');
mcpManager.getAllToolsAsOpenAI = async () => [
    fnTool('mcp_srv1_lookup', { _mcp: { serverId: 'srv1' } }),
    fnTool('mcp_srv1_write', { _mcp: { serverId: 'srv1' } }),
    fnTool('mcp_srv2_hidden', { _mcp: { serverId: 'srv2' } }),
    fnTool('mcp_orphan'),
];
mcpManager.getServersForUser = async () => [
    { id: 'srv1', allConfigured: true },
    { id: 'srv2', allConfigured: true },
    { id: 'srv3', allConfigured: false },
];

const gate = require('../customIntegrations/mcpLibrary/gate');
gate.loadRunGate = async () => ({ anyRunnable: true, isRunnable: (row) => row.id !== 'c-off' });
const orgCustomIntegrationStore = require('../../stores/orgCustomIntegrationStore');
orgCustomIntegrationStore.listActiveForOrg = async () => [
    { id: 'c1', toolsCache: [fnTool('cint_crm_find'), fnTool('cint_crm_add')] },
    { id: 'c-off', toolsCache: [fnTool('cint_off_x')] },
    { id: 'c-ungranted', toolsCache: [fnTool('cint_nope_x')] },
];
orgCustomIntegrationStore.getBySlug = async (slug) => (slug === 'crm' ? { name: 'Our CRM' } : null);

const ncClient = require('../../integrations/nextcloudClient');
ncClient.resolveNcBinding = async () => S.ncBinding;
const ncScope = require('./ncScope');
ncScope.resolveNcScope = async () => S.ncScope;

const automationCredentialStore = require('../../stores/automationCredentialStore');
automationCredentialStore.getCredential = async () => S.withings;

const webpageStore = require('../../stores/webpageStore');
webpageStore.userHasAnyWebpageAccess = async () => S.webpageAccess;

const datatableTools = require('../tools/datatableTools');
datatableTools.buildDatatableTools = async ({ agentConfig }) => (agentConfig?.tools?.datatables ? [fnTool('datatable_query')] : []);

const callable = require('../../automation/agentCallableTools');
callable.getAgentCallableTools = async ({ agentId }) => (agentId === 'agt-1'
    ? [fnTool('automation_send_invoice', { __automation: { id: 'auto-1' } })] : []);
callable.getStepToolsForUser = async () => [fnTool('step_cleanup')];

const pwtRunner = require('../../services/pwtRunner');
pwtRunner.dockerAvailable = async () => false;

const mod = require('./integrationTools');

// ── Helpers ────────────────────────────────────────────────────────────────
function snap(integration, { core = ['notebooks'], degraded = false } = {}) {
    return { degraded, tier: 'enterprise', ceiling: { core, integration, beta: [] }, effective: { core, integration, beta: [] } };
}

const ALL_SECRETS = {
    google_api_key: 'g', elevenlabs_api_key: 'e', serper_api_key: 's', mistral_api_key: 'm', google_maps_api_key: 'gm',
    fireflies_api_key_user_u1: 'f', youtrack_url_user_u1: 'https://yt', youtrack_token_user_u1: 't',
    gamma_api_key_user_u1: 'ga', signrequest_subdomain_user_u1: 'sr', signrequest_token_user_u1: 'srt',
    afas_token_user_u1: 'a', afas_member_number_user_u1: '1', nmbrs_subdomain_user_u1: 'n', nmbrs_token_user_u1: 'nt',
    vplan_api_key_user_u1: 'v', vplan_api_env_user_u1: 've',
    firebird_host_user_u1: 'fh', firebird_database_user_u1: 'fd', firebird_user_user_u1: 'fu', firebird_password_user_u1: 'fp',
    scaleway_billing_secret_key_user_u1: 'sc',
    linkedin_access_token_user_u1: 'li', github_token_user_u1: 'gh', n8n_api_key_org_o1: 'nk',
};
const ALL_INTEGRATIONS = [
    'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets', 'google-slides', 'google-contacts',
    'google-keep', 'google-groups', 'outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts',
    'image-gen', 'video-gen', 'elevenlabs', 'agent-search', 'browser-fetch', 'fireflies', 'youtrack', 'gamma',
    'signrequest', 'afas-profit', 'nmbrs', 'vplan', 'firebird', 'scaleway-billing', 'n8n', 'linkedin', 'withings',
    'google-maps', 'github', 'transcription', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts',
    'nextcloud-deck', 'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes',
    'nextcloud-mail', 'nextcloud-activity', 'nextcloud-tables', 'nextcloud-forms', 'nextcloud-teams',
    'nextcloud-status', 'mcp:srv1', 'custom:c1',
];
const names = (r) => r.tools.map(t => t.function.name);

async function scenarioGoogleFull() {
    reset({
        secrets: { ...ALL_SECRETS },
        config: { search_provider: 'node-search', n8n_url_org_o1: 'https://n8n', oauth: { nextcloudUrl: 'https://nc' } },
        snapshot: snap(ALL_INTEGRATIONS),
        withings: { status: 'active' },
        appPassword: { username: 'tom', password: 'pw', url: null },
        ncScope: { 'nextcloud-talk': { mode: 'off' } },
        beta: true,
    });
    const session = { oauthProvider: 'google', accessToken: 'tok', user: { id: 'u1', role: 'user' } };
    const r = await mod.getIntegrationTools({
        userId: 'u1', session, isAdmin: true, agentId: 'agt-1', automationStep: true,
        agentConfig: { knowledge_base_ids: ['kb1'], tools: { datatables: { t1: {} } } },
    });
    const keys = S.configKeys.slice();
    const hint = await mod.buildToolHint(r.tools, 'u1');
    return { tools: names(r), n8nOrgId: r.n8nOrgId, configKeys: keys, hint };
}

async function scenarioMicrosoftSimple() {
    reset({
        secrets: { ...ALL_SECRETS },
        config: { simple_mode_user_u1: true, enabled_apps_user_u1: ['outlook', 'gamma'], search_provider: 'bing' },
        snapshot: snap(ALL_INTEGRATIONS),
        groups: [{ id: 'g1', disabled_integrations: ['nextcloud-deck'] }],
    });
    const session = { oauthProvider: 'microsoft', accessToken: 'tok', user: { id: 'u1', role: 'user' } };
    const r = await mod.getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    const keys = S.configKeys.slice();
    const hint = await mod.buildToolHint(r.tools);
    return { tools: names(r), n8nOrgId: r.n8nOrgId, configKeys: keys, hint };
}

async function scenarioDegradedLegacyGate() {
    reset({
        secrets: { fireflies_api_key_user_u1: 'f', github_token_user_u1: 'gh', google_api_key: 'g' },
        config: { oauth: {}, feature_notebooks_enabled: false },
        snapshot: snap([], { degraded: true }),
        org: { id: 'o1', enabledIntegrations: ['fireflies', 'image-gen', 'nextcloud', 'nextcloud-deck'] },
        orgActive: ['fireflies', 'image-gen'],
        ncBinding: { orgId: 'o1' },
        groups: [{ id: 'g1', disabled_integrations: ['nextcloud-deck'] }],
    });
    const session = { user: { id: 'u1', role: 'user' }, oauthProvider: 'nextcloud' };
    const r = await mod.getIntegrationTools({
        userId: 'u1', session, isAdmin: false,
        extraEnabledApps: ['fireflies'], enabledAppsOverride: ['image-gen'],
    });
    const keys = S.configKeys.slice();
    return { tools: names(r), n8nOrgId: r.n8nOrgId, configKeys: keys, hint: await mod.buildToolHint(r.tools) };
}

async function scenarioDesignTimeGate() {
    reset({
        config: { enabled_apps_user_u1: ['gmail', 'youtrack'] },
        snapshot: snap(['gmail', 'agent-search', 'nextcloud', 'nextcloud-deck', 'outlook']),
        groups: [{ id: 'g1', disabled_integrations: ['nextcloud-deck'] }],
        webpageAccess: true,
    });
    const session = { user: { id: 'u1', role: 'user' } };
    const permitted = [...await mod.getUserPermittedApps({ userId: 'u1', session, isAdmin: false })].sort();
    const one = {};
    for (const appId of ['gmail', 'youtrack', 'browser-fetch', 'webpages', 'nextcloud-deck', 'workspace', 'outlook']) {
        one[appId] = await mod.isIntegrationPermittedForUser({ userId: 'u1', appId, session, isAdmin: false });
    }
    const allow = await mod.webpageToolsAllowed({ userId: 'u1', groupIds: ['g1'], orgId: 'o1' });
    const mcpIds = [...await mod.availableMcpServerIds(new Set(['mcp_srv1_lookup', 'mcp_srv3_x', 'gmail_send']), 'u1')];
    const appended = [];
    await mod.appendMcpTools(appended, { effectiveIntegrations: new Set(['mcp:srv1']), isToolGranted: (t) => t.function.name !== 'mcp_srv1_write' });
    await mod.appendCustomIntegrationTools(appended, { effectiveIntegrations: new Set(['custom:c1', 'custom:c-off']), orgId: 'o1' });
    await mod.appendCustomIntegrationTools(appended, { effectiveIntegrations: new Set(['custom:c1']), orgId: '__system__' });
    await mod.appendMcpTools(appended, { effectiveIntegrations: null });
    return { permitted, one, webpageToolsAllowed: allow, mcpIds, appended: appended.map(t => t.function.name) };
}

test('golden: exported keys', async () => {
    const actual = await collect();
    const golden = loadOrWrite(actual);
    assert.deepEqual(actual.exports, golden.exports);
});

let _collected = null;
async function collect() {
    if (_collected) return _collected;
    _collected = {
        exports: Object.keys(mod).sort(),
        googleFull: await scenarioGoogleFull(),
        microsoftSimple: await scenarioMicrosoftSimple(),
        degradedLegacyGate: await scenarioDegradedLegacyGate(),
        designTimeGate: await scenarioDesignTimeGate(),
    };
    return _collected;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of ['googleFull', 'microsoftSimple', 'degradedLegacyGate', 'designTimeGate']) {
    test(`golden: ${key}`, async () => {
        const actual = await collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(actual[key], golden[key]);
    });
}
