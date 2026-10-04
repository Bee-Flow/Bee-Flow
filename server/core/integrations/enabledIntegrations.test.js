/**
 * Which integrations a headless session loads provider tokens for.
 *
 * The regression fixture below is REAL data from a box where an App Studio
 * connector told the owner to "connect Gmail" while Gmail was connected:
 *
 *   organizations.org_enabled_integrations = ["gmail","google-calendar",…]  ← current
 *   organizations."enabledIntegrations"    = NULL                           ← legacy
 *   config.enabled_apps_user_<id>          = absent
 *
 * Reading only the legacy column yielded [], which makes
 * automationAuth.buildUserAuth take its `required.length === 0` shortcut and return
 * a TRUTHY object with a null accessToken — so the caller adopted a token-less
 * session and the Google client reported a connected account as not connected.
 *
 * Run: cd server && node --test core/enabledIntegrations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let orgs = {};
let configs = {};
stub('../../stores/userStore', { getOrganization: async (id) => orgs[id] || null });
stub('../../stores/configStore', { getConfig: async (key) => (key in configs ? configs[key] : null) });

const { mergeEnabled, resolveEnabledIntegrations, resolveOrgIntegrations } = require('./enabledIntegrations');

const GOOGLE_APPS = ['gmail', 'google-calendar', 'google-drive', 'google-slides', 'google-sheets', 'google-docs', 'google-contacts', 'google-keep', 'google-groups', 'browser-fetch', 'vplan'];

test.beforeEach(() => { orgs = {}; configs = {}; });

// ── the regression ──────────────────────────────────────────────────

test('THE BUG: an org using only the CURRENT column still resolves its integrations', async () => {
    orgs['bee-flow'] = { orgEnabledIntegrations: GOOGLE_APPS, enabledIntegrations: null };
    // The user never opened the app-toggles panel, so no saved list exists.
    const enabled = await resolveEnabledIntegrations('tomsmit', 'bee-flow');
    assert.ok(enabled.includes('gmail'), 'gmail must be in the list — reading only the legacy column returned []');
    assert.ok(enabled.includes('google-drive'));
});

test('the legacy column alone still works (orgs a super-admin overrode)', async () => {
    orgs['legacy-org'] = { orgEnabledIntegrations: null, enabledIntegrations: '["gmail","outlook"]' };
    const enabled = await resolveEnabledIntegrations('u1', 'legacy-org');
    assert.deepStrictEqual(enabled.sort(), ['gmail', 'outlook']);
});

test('both columns are UNIONED, not one-or-the-other', async () => {
    orgs['both'] = { orgEnabledIntegrations: ['gmail'], enabledIntegrations: '["outlook"]' };
    const enabled = await resolveEnabledIntegrations('u1', 'both');
    assert.deepStrictEqual(enabled.sort(), ['gmail', 'outlook']);
});

test('an org declaring neither falls back to the deployment default', async () => {
    orgs['bare'] = { orgEnabledIntegrations: null, enabledIntegrations: null };
    configs['default_org_integrations'] = '["gmail","nextcloud"]';
    const enabled = await resolveEnabledIntegrations('u1', 'bare');
    assert.deepStrictEqual(enabled.sort(), ['gmail', 'nextcloud']);
});

// ── include: correctness independent of config ──────────────────────

test('include forces the integration being dispatched in, even when EVERYTHING is empty', async () => {
    // The belt-and-braces that makes a connector run correct regardless of how
    // the org's lists happen to be configured.
    const enabled = await resolveEnabledIntegrations('u1', null, { include: ['gmail'] });
    assert.deepStrictEqual(enabled, ['gmail']);
});

test('include survives an org list that would otherwise exclude it', async () => {
    orgs['narrow'] = { orgEnabledIntegrations: ['vplan'], enabledIntegrations: null };
    configs['enabled_apps_user_u1'] = ['vplan'];
    const enabled = await resolveEnabledIntegrations('u1', 'narrow', { include: ['gmail'] });
    assert.ok(enabled.includes('gmail'));
    assert.ok(enabled.includes('vplan'));
    // Widening this list can never grant a tool: getIntegrationTools/isAppOn
    // still re-checks org, group and personal grants downstream.
});

test('include does not duplicate an id already present', async () => {
    orgs['o'] = { orgEnabledIntegrations: ['gmail'], enabledIntegrations: null };
    const enabled = await resolveEnabledIntegrations('u1', 'o', { include: ['gmail'] });
    assert.deepStrictEqual(enabled, ['gmail']);
});

// ── user ∩ org ──────────────────────────────────────────────────────

test('a saved user list narrows the org list', async () => {
    orgs['o'] = { orgEnabledIntegrations: ['gmail', 'outlook', 'vplan'], enabledIntegrations: null };
    configs['enabled_apps_user_u1'] = ['gmail', 'vplan'];
    const enabled = await resolveEnabledIntegrations('u1', 'o');
    assert.deepStrictEqual(enabled.sort(), ['gmail', 'vplan']);
});

test('mergeEnabled treats a MISSING list as "no restriction", not as "none"', () => {
    // A user who never toggled anything has no list at all — the rest of the
    // codebase reads that as "all enabled", and so must this.
    assert.deepStrictEqual(mergeEnabled(null, ['gmail']), ['gmail']);
    assert.deepStrictEqual(mergeEnabled(['gmail'], null), ['gmail']);
    assert.deepStrictEqual(mergeEnabled(null, null), []);
    assert.deepStrictEqual(mergeEnabled(['a', 'b'], ['b', 'c']), ['b']);
});

// ── robustness ──────────────────────────────────────────────────────

test('a store failure does not silently narrow the list to nothing', async () => {
    const userStore = require('../../stores/userStore');
    const original = userStore.getOrganization;
    userStore.getOrganization = async () => { throw new Error('db down'); };
    try {
        // null org list + the forced include = the dispatched tool still works.
        const enabled = await resolveEnabledIntegrations('u1', 'o', { include: ['gmail'] });
        assert.deepStrictEqual(enabled, ['gmail']);
    } finally { userStore.getOrganization = original; }
});

test('malformed JSON in a column is ignored rather than throwing', async () => {
    orgs['bad'] = { orgEnabledIntegrations: null, enabledIntegrations: '{not json' };
    configs['default_org_integrations'] = '["gmail"]';
    assert.deepStrictEqual(await resolveOrgIntegrations('bad'), ['gmail']);
});

test('an org id of null resolves to no org restriction', async () => {
    assert.strictEqual(await resolveOrgIntegrations(null), null);
});
