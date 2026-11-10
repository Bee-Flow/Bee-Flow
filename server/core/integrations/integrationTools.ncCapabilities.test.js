// @typecheck
/**
 * Tool assembly and the Nextcloud capabilities read.
 *
 * Chat and agent assembly pass `hideAbsentNextcloudApps`. With it, the tool
 * family of an app the server reports as not installed is left out; a family
 * whose app publishes no capability (Mail, Calendar, ...) and every family
 * after a failed read stay offered. Without it (catalogues, automations) the
 * capabilities are not read at all.
 *
 * Run: cd server && SESSION_SECRET=test-session-secret-at-least-32-chars-long node --test core/integrations/integrationTools.ncCapabilities.test.js
 * DB-free: same monkeypatch harness as integrationTools.ncBinding.test.js.
 */
'use strict';

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const test = require('node:test');
const assert = require('node:assert');

const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;
const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

const configStore = require('../../stores/configStore');
configStore.getConfig = async () => null;
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

const NC_IDS = ['nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck',
    'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes',
    'nextcloud-mail', 'nextcloud-activity', 'nextcloud-tables', 'nextcloud-forms',
    'nextcloud-teams', 'nextcloud-status'];

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => ({
    degraded: false,
    tier: 'enterprise',
    ceiling: { core: [], integration: NC_IDS, beta: [] },
    effective: { core: [], integration: NC_IDS, beta: [] },
});

/** @type {{ status: number, capabilities: Record<string, unknown>, fetches: number }} */
const fx = { status: 200, capabilities: {}, fetches: 0 };
let server = 0;
const ncClient = require('../../integrations/nextcloudClient');
ncClient.resolveNcBinding = async () => ({ orgId: 'org-nc', ncUid: 'tom' });
ncClient.resolveAuth = /** @type {any} */ (async () => ({
    baseUrl: `https://cloud-${server}.example.test`,
    uid: 'tom',
    fetch: async () => {
        fx.fetches++;
        return {
            ok: fx.status >= 200 && fx.status < 300,
            status: fx.status,
            text: async () => JSON.stringify({ ocs: { data: { capabilities: { core: {}, dav: {}, ...fx.capabilities } } } }),
        };
    },
}));

const { getIntegrationTools } = require('./integrationTools');

const session = { user: { id: 'u1', provider: 'nextcloud_connector' }, connectorOrgId: 'org-nc' };
/** One tool name per family, in the order the families are offered. */
const PROBE = {
    'nextcloud': 'nextcloud_list_files',
    'nextcloud-calendar': 'nextcloud_calendar_list',
    'nextcloud-contacts': 'nextcloud_contacts_list',
    'nextcloud-deck': 'nextcloud_deck_list_boards',
    'nextcloud-notifications': 'nextcloud_notifications_list',
    'nextcloud-talk': 'nextcloud_talk_list_rooms',
    'nextcloud-tasks': 'nextcloud_tasks_list',
    'nextcloud-notes': 'nextcloud_notes_list',
    'nextcloud-mail': 'nextcloud_mail_search',
    'nextcloud-activity': 'nextcloud_activity_list',
    'nextcloud-tables': 'nextcloud_tables_list',
    'nextcloud-forms': 'nextcloud_forms_list',
    'nextcloud-teams': 'nextcloud_teams_list',
    'nextcloud-status': 'nextcloud_status_get',
};

/** @param {Record<string, unknown>} [extra] */
async function offeredFamilies(extra = {}) {
    server++; // a new server per call, so no call reads another one's cached answer
    const { tools } = await getIntegrationTools(/** @type {any} */ ({ userId: 'u1', session, isAdmin: false, ...extra }));
    const names = new Set(tools.map(t => t.function.name));
    return Object.entries(PROBE).filter(([, tool]) => names.has(tool)).map(([family]) => family);
}

test.beforeEach(() => { Object.assign(fx, { status: 200, capabilities: {}, fetches: 0 }); });

test('every probe tool exists: without the filter all fourteen families are offered', async () => {
    assert.deepStrictEqual(await offeredFamilies(), NC_IDS);
    assert.strictEqual(fx.fetches, 0, 'the capabilities are not read unless the caller asks');
});

test('chat and agents: a family whose app is not installed is left out', async () => {
    fx.capabilities = { deck: {}, spreed: {}, notes: {}, activity: {} };
    assert.deepStrictEqual(
        await offeredFamilies({ hideAbsentNextcloudApps: true }),
        NC_IDS.filter(id => !['nextcloud-tables', 'nextcloud-forms', 'nextcloud-teams'].includes(id)),
    );
    assert.strictEqual(fx.fetches, 1);
});

test('chat and agents: families without a capability to look for stay offered on a bare server', async () => {
    fx.capabilities = {};
    assert.deepStrictEqual(await offeredFamilies({ hideAbsentNextcloudApps: true }), [
        'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-notifications',
        'nextcloud-tasks', 'nextcloud-mail', 'nextcloud-status',
    ]);
});

test('chat and agents: every app installed keeps every family, in the same order', async () => {
    fx.capabilities = { deck: {}, spreed: {}, notes: {}, activity: {}, tables: {}, forms: {}, circles: {} };
    assert.deepStrictEqual(await offeredFamilies({ hideAbsentNextcloudApps: true }), NC_IDS);
});

test('chat and agents: a failed capabilities read keeps every family', async () => {
    for (const status of [401, 500, 503]) {
        fx.status = status;
        assert.deepStrictEqual(await offeredFamilies({ hideAbsentNextcloudApps: true }), NC_IDS, String(status));
    }
});

test('an automation step lists every family whatever the server has installed', async () => {
    fx.capabilities = {};
    assert.deepStrictEqual(await offeredFamilies({ automationStep: true }), NC_IDS);
    assert.strictEqual(fx.fetches, 0);
});
