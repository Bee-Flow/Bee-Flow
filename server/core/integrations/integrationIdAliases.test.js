'use strict';

/**
 * Google Maps had two ids: `maps` in the capability registry, the client
 * catalogue and every organisation allow-list, `google-maps` in the runtime
 * gate. `google-maps` is no registry id, so the runtime fell back to the
 * legacy allow-list check and dropped the Maps tools for every organisation
 * with an explicit list, even one that granted `maps`. These cases pin the
 * alias table, the registry against the ids the gates check, and both gates
 * for an organisation whose list says `maps`.
 *
 * Run: cd server && node --test core/integrations/integrationIdAliases.test.js
 */

process.env.NODE_ENV = 'test';
require('../../boot/featureModules');
const test = require('node:test');
const assert = require('node:assert');

const {
    canonicalIntegrationId, integrationIdAliases, listHasIntegration, integrationIdAliasTable,
} = require('./integrationIdAliases.mts');
const capabilityRegistry = require('../entitlements/capabilityRegistry');
const { TOOL_REGISTRY } = require('../../automation/toolRegistry');
const { createRuntimeAppGate } = require('./runtimeAppGate');
const { createUserAppGate } = require('./userAppGate');
const { addPersonalServiceTools } = require('./integrationToolGroups');

const registryIntegrationIds = new Set(capabilityRegistry.listByKind('integration').map((c) => c.id));

test('the legacy Google Maps id resolves to the catalogue id', () => {
    assert.strictEqual(canonicalIntegrationId('google-maps'), 'maps');
    assert.strictEqual(canonicalIntegrationId('maps'), 'maps');
    assert.strictEqual(canonicalIntegrationId('github'), 'github');
    assert.deepStrictEqual([...integrationIdAliases('google-maps')], ['maps', 'google-maps']);
    assert.deepStrictEqual([...integrationIdAliases('github')], ['github']);
});

test('a list names an integration under any of its ids', () => {
    assert.ok(listHasIntegration(['maps'], 'google-maps'));
    assert.ok(listHasIntegration(['google-maps'], 'maps'));
    assert.ok(listHasIntegration(new Set(['maps']), 'google-maps'));
    assert.ok(!listHasIntegration(['github'], 'maps'));
    assert.ok(!listHasIntegration(null, 'maps'));
});

test('every alias points at a registry integration, and no registry id is itself an alias', () => {
    for (const [legacy, canonical] of Object.entries(integrationIdAliasTable())) {
        assert.ok(registryIntegrationIds.has(canonical), `${legacy} → ${canonical}: ${canonical} is not a registry integration`);
        assert.ok(!registryIntegrationIds.has(legacy), `${legacy} is a registry id and an alias at once`);
    }
    for (const id of registryIntegrationIds) {
        assert.strictEqual(canonicalIntegrationId(id), id, `registry id ${id} is rewritten by the alias table`);
    }
});

test('every TOOL_REGISTRY entry is gated on the id the registry knows it by', () => {
    // `enabledKey` mirrors the id isAppOn() is asked about. Where the app is a
    // registry integration, that key must be the registry id or one of its
    // aliases, or an organisation's grant never reaches the tools.
    for (const entry of TOOL_REGISTRY) {
        const app = canonicalIntegrationId(entry.app);
        if (!registryIntegrationIds.has(app) || !entry.enabledKey) continue;
        assert.strictEqual(canonicalIntegrationId(entry.enabledKey), app,
            `${entry.app}: enabledKey ${entry.enabledKey} is not the registry id ${app} or an alias of it`);
    }
});

test('the Maps tools are asked for under the registry id', async () => {
    const asked = [];
    const added = [];
    const T = { LINKEDIN_TOOLS: ['li'], WITHINGS_TOOLS: ['wi'], MAPS_TOOLS: ['maps'], GITHUB_TOOLS: ['gh'] };
    await addPersonalServiceTools({
        userId: 'u1',
        isAppOn: (id) => { asked.push(id); return true; },
        addTools: (tools) => added.push(tools),
        isLentProvider: async () => false,
        T,
        D: {
            configStore: { getSecret: async (k) => (k === 'google_maps_api_key' ? 'key' : null) },
            automationCredentialStore: () => ({ getCredential: async () => null }),
        },
    });
    assert.ok(added.includes(T.MAPS_TOOLS), 'the Maps tools were not added');
    const mapsAsk = asked.find((id) => canonicalIntegrationId(id) === 'maps');
    assert.ok(mapsAsk, `no gate question for Maps among ${asked.join(', ')}`);
    assert.ok(registryIntegrationIds.has(canonicalIntegrationId(mapsAsk)));
});

// ── Both gates, for an organisation with an explicit list ─────────────────

function gateDeps({ orgList, effective = null, userApps = null }) {
    const configStore = {
        getConfig: async (key) => (key.startsWith('enabled_apps_user_') ? userApps : null),
    };
    const lazy = {
        userStore: () => ({
            getUser: async () => ({ id: 'u1', organizationId: 'o1', groups: [] }),
            getOrganization: async () => ({ id: 'o1' }),
            getAllGroups: async () => [],
        }),
        // `effective` null = a degraded snapshot, so the legacy org-list branch decides.
        entitlements: () => ({
            resolveEntitlements: async () => (effective
                ? { degraded: false, effective: { integration: effective } }
                : { degraded: true, effective: { integration: [] } }),
        }),
        capabilityRegistry: () => capabilityRegistry,
    };
    return { configStore, lazy, resolveOrgAllowList: async () => orgList };
}

async function runtimeIsAppOn(opts) {
    const { configStore, lazy, resolveOrgAllowList } = gateDeps(opts);
    const resolve = createRuntimeAppGate({ configStore, resolveOrgAllowList, resolveOrgActiveSet: async () => null, lazy });
    const { isAppOn } = await resolve({ userId: 'u1', session: { user: { id: 'u1', role: 'user' } }, isAdmin: false });
    return isAppOn;
}

async function designIsAppOn(opts) {
    const { configStore, lazy, resolveOrgAllowList } = gateDeps(opts);
    const { buildUserAppGate } = createUserAppGate({
        configStore, resolveOrgAllowList, webpageToolsAllowed: async () => false, lazy,
    });
    return buildUserAppGate({ userId: 'u1', session: { user: { id: 'u1', role: 'user' } }, isAdmin: false, onlyAppId: 'maps' });
}

for (const [label, build] of [['runtime gate', runtimeIsAppOn], ['design-time gate', designIsAppOn]]) {
    test(`${label}: an org list that grants 'maps' turns Maps on under either id`, async () => {
        const isAppOn = await build({ orgList: ['github', 'maps'] });
        assert.strictEqual(isAppOn('maps'), true);
        assert.strictEqual(isAppOn('google-maps'), true);
    });

    test(`${label}: an org list without Maps keeps it off under either id`, async () => {
        const isAppOn = await build({ orgList: ['github'] });
        assert.strictEqual(isAppOn('maps'), false);
        assert.strictEqual(isAppOn('google-maps'), false);
    });

    test(`${label}: an older org list that says 'google-maps' still grants Maps`, async () => {
        const isAppOn = await build({ orgList: ['google-maps'] });
        assert.strictEqual(isAppOn('maps'), true);
    });

    test(`${label}: the entitlement snapshot decides by the registry id`, async () => {
        const on = await build({ orgList: ['github'], effective: ['github', 'maps'] });
        assert.strictEqual(on('maps'), true);
        assert.strictEqual(on('google-maps'), true);
        const off = await build({ orgList: ['github', 'maps'], effective: ['github'] });
        assert.strictEqual(off('maps'), false);
        assert.strictEqual(off('google-maps'), false);
    });

    test(`${label}: Maps stays auto-enabled for a user whose saved app list predates it`, async () => {
        const isAppOn = await build({ orgList: ['maps'], userApps: ['gmail'] });
        assert.strictEqual(isAppOn('maps'), true);
    });
}
