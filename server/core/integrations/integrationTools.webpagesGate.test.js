'use strict';

/**
 * The webpage tools (webpages_*, webpage_db_query, webpage_db_exec) under the
 * design-time gate — BFSF-413.
 *
 * `webpages` is a beta capability, not an org integration, so no org
 * integration allow-list can name it. The design-time gate (buildUserAppGate,
 * read by routine save/activate validation and the AI builder) judged it by
 * that list anyway, while the runtime (getIntegrationTools) hands the tools
 * out on the beta feature OR access to a webpage. In an org with an allow-list
 * the palette offered the step, the runtime would run it, and the validator
 * refused it as "not in user's catalog".
 *
 * Both now ask webpageToolsAllowed. What must hold:
 *   • an allow-list org no longer hides webpages from a user the runtime
 *     serves (beta on, or a webpage to act on);
 *   • the gate does not widen past the runtime: no beta and no access, or
 *     Simple Mode, still answers no — this gate also authorises
 *     (isIntegrationPermittedForUser), so a blanket yes would be a hole;
 *   • the helper never throws: activate is fail-OPEN on an exception.
 *
 * Run: cd server && node --test core/integrations/integrationTools.webpagesGate.test.js
 */

const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const state = {};
function reset() {
    state.config = {};
    state.beta = false;
    state.betaThrows = false;
    state.webpageAccess = false;
    state.accessThrows = false;
    state.accessCalls = [];
    state.betaCalls = 0;
    state.user = { id: 'u1', organizationId: 'org1', groups: ['g1'] };
    // The shape from the report: an org whose integration list is narrow.
    state.org = { id: 'org1', enabledIntegrations: ['agent-search', 'youtrack'] };
}
reset();

// Patched before integrationTools loads: it destructures userHasBetaFeature.
const configStore = require('../../stores/configStore');
mock.method(configStore, 'getConfig', async (k) => state.config[k] ?? null);
mock.method(configStore, 'getSecret', async () => null);
const entitlements = require('../entitlements/entitlements');
mock.method(entitlements, 'resolveEntitlements', async () => ({ degraded: true, effective: { integration: [] } }));
const betaFeatures = require('../entitlements/betaFeatures');
mock.method(betaFeatures, 'userHasBetaFeature', async (_userId, featureId) => {
    state.betaCalls += 1;
    if (state.betaThrows) throw new Error('entitlement store down');
    return featureId === 'webpages' && state.beta;
});
const userStore = require('../../stores/userStore');
mock.method(userStore, 'getUser', async () => state.user);
mock.method(userStore, 'getOrganization', async () => state.org);
mock.method(userStore, 'getAllGroups', async () => []);
const webpageStore = require('../../stores/webpageStore');
mock.method(webpageStore, 'userHasAnyWebpageAccess', async (userId, groupIds, orgIds) => {
    state.accessCalls.push({ userId, groupIds, orgIds });
    if (state.accessThrows) throw new Error('db down');
    return state.webpageAccess;
});

const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { getUserPermittedApps, isIntegrationPermittedForUser, webpageToolsAllowed } = require('./integrationTools');

const USER = { userId: 'u1', session: { user: { id: 'u1' } }, isAdmin: false };

/** The catalog routine activation validates against (routes/automation/activate.js). */
async function activationCatalog() {
    const permitted = await getUserPermittedApps(USER);
    const names = new Set();
    for (const entry of TOOL_REGISTRY) {
        if (!permitted.has(entry.app)) continue;
        for (const t of loadTools(entry)) if (t?.function?.name) names.add(t.function.name);
    }
    return names;
}

beforeEach(reset);

test('an allow-list org with the webpages beta on: the webpage db tools are in the catalog', async () => {
    state.beta = true;
    const permitted = await getUserPermittedApps(USER);
    assert.ok(permitted.has('webpages'), 'the allow-list cannot name webpages, so it must not decide it');
    assert.ok(permitted.has('youtrack'), 'the allow-list still grants what it names');
    assert.ok(!permitted.has('gmail'), 'and still withholds what it does not');

    const catalog = await activationCatalog();
    assert.ok(catalog.has('webpage_db_query'));
    assert.ok(catalog.has('webpage_db_exec'));
    assert.equal(await isIntegrationPermittedForUser({ ...USER, appId: 'webpages' }), true);
});

test('no beta but a webpage to act on: granted, like the runtime', async () => {
    state.webpageAccess = true;
    assert.ok((await getUserPermittedApps(USER)).has('webpages'));
    // The access probe sees the same groups and org the runtime passes it.
    assert.deepEqual(state.accessCalls.at(-1), { userId: 'u1', groupIds: ['g1'], orgIds: ['org1'] });
});

test('no beta and no webpage access: refused, even without an org allow-list', async () => {
    assert.ok(!(await getUserPermittedApps(USER)).has('webpages'));
    state.org = { id: 'org1', enabledIntegrations: null };
    assert.ok(!(await getUserPermittedApps(USER)).has('webpages'),
        'the runtime would not hand out the tools, so the validator must not pass the step');
    assert.equal(await isIntegrationPermittedForUser({ ...USER, appId: 'webpages' }), false);
});

test('Simple Mode withholds webpages, beta or not', async () => {
    state.beta = true;
    state.webpageAccess = true;
    state.config['simple_mode_user_u1'] = true;
    assert.ok(!(await getUserPermittedApps(USER)).has('webpages'));
    assert.equal(await webpageToolsAllowed({ userId: 'u1', simpleMode: true }), false);
});

test('the helper answers no instead of throwing', async () => {
    state.betaThrows = true;
    state.webpageAccess = true;
    assert.equal(await webpageToolsAllowed({ userId: 'u1' }), false, 'a failed beta lookup fails closed');

    state.betaThrows = false;
    state.accessThrows = true;
    assert.equal(await webpageToolsAllowed({ userId: 'u1', orgId: 'org1' }), false, 'a failed access probe fails closed');

    assert.equal(await webpageToolsAllowed({}), false);
    assert.equal(await webpageToolsAllowed(), false);
});

test('asking about one other app does not run the webpage lookups', async () => {
    // isIntegrationPermittedForUser guards Nextcloud Tables links, spreadsheet
    // links and browse steps; none of them may pay for the webpages rule.
    assert.equal(await isIntegrationPermittedForUser({ ...USER, appId: 'youtrack' }), true);
    assert.equal(await isIntegrationPermittedForUser({ ...USER, appId: 'gmail' }), false);
    assert.equal(state.betaCalls, 0);
    assert.deepEqual(state.accessCalls, []);

    state.webpageAccess = true;
    assert.equal(await isIntegrationPermittedForUser({ ...USER, appId: 'webpages' }), true,
        'asked about webpages itself, the rule still runs');
});
