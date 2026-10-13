/**
 * Pins the org allow-list reads that used to live inline at each call site.
 *
 * Every oracle below is a VERBATIM copy of the inline code a caller had before it
 * switched to resolveOrgAllowList / resolveOrgActiveSet. The helper, called with
 * that caller's options, must give the same answer (or throw the same way) for
 * every combination of org column and global default.
 *
 * Run: cd server && node --test core/integrations/enabledIntegrations.allowList.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let globalDefaultsValue = null;
let configReads = 0;
let activeImpl = async () => [];
stub('../../stores/configStore', {
    getConfig: async (key) => { configReads++; return key === 'default_org_integrations' ? globalDefaultsValue : null; },
});
stub('../../stores/userStore', {
    getOrganization: async () => null,
    getOrgEnabledIntegrations: (...a) => activeImpl(...a),
});
const configStore = require('../../stores/configStore');

const {
    resolveOrgAllowList, resolveOrgAllowListWithSource, resolveOrgActiveSet,
} = require('./enabledIntegrations');

const ALL_IDS = ['gmail', 'outlook', 'n8n'];

// ── oracles: the inline code as it stood before the switch ─────────────

// integrationTools.getIntegrationTools (and the palette helper, the wizard and
// /auth/me, which had the same shape): truthy override, strict parse.
async function oracleRuntime(org) {
    let orgEnabledIntegrations = null;
    if (org?.enabledIntegrations) {
        orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
            ? JSON.parse(org.enabledIntegrations)
            : org.enabledIntegrations;
    } else {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        if (globalDefaults) {
            orgEnabledIntegrations = typeof globalDefaults === 'string'
                ? JSON.parse(globalDefaults)
                : globalDefaults;
        }
    }
    return orgEnabledIntegrations;
}

// routes/ai/config/integrations.js n8n diagnostics: same, plus a source label.
async function oracleN8n(org) {
    let orgEnabledIntegrations = null;
    let orgGateSource = 'all_enabled';
    if (org?.enabledIntegrations) {
        orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
            ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
        orgGateSource = 'org_override';
    } else {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        if (globalDefaults) {
            orgEnabledIntegrations = typeof globalDefaults === 'string'
                ? JSON.parse(globalDefaults) : globalDefaults;
            orgGateSource = 'global_default';
        }
    }
    return { list: orgEnabledIntegrations, source: orgGateSource };
}

// auth/admin/featureAccessRoutes.js (three places): present override, lenient
// parse, all catalogue ids when nothing is configured.
function parseAllowedIntegrations(raw) {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}
async function oracleFeatureAccess(org) {
    let allowed;
    const raw = org?.enabledIntegrations;
    if (raw === null || raw === undefined) {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        allowed = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_IDS.map(i => i);
    } else {
        allowed = parseAllowedIntegrations(raw);
    }
    return allowed;
}

// getIntegrationTools / wizard: the org-admin active subset.
async function oracleActiveSet(orgId, isSuperAdmin) {
    let orgActiveSet = null;
    if (!isSuperAdmin) {
        try {
            const activeList = await activeImpl(orgId);
            orgActiveSet = new Set(activeList);
        } catch (_) { orgActiveSet = new Set(); }
    }
    return orgActiveSet;
}

// ── the matrix ─────────────────────────────────────────────────────────

const ORGS = [
    null,
    {},
    { enabledIntegrations: null },
    { enabledIntegrations: undefined },
    { enabledIntegrations: '' },
    { enabledIntegrations: '[]' },
    { enabledIntegrations: '["gmail"]' },
    { enabledIntegrations: 'not json' },
    { enabledIntegrations: '{"x":1}' },
    { enabledIntegrations: '5' },
    { enabledIntegrations: [] },
    { enabledIntegrations: ['gmail', 'n8n'] },
    { enabledIntegrations: 0 },
];
const DEFAULTS = [null, undefined, '', '[]', '["outlook"]', 'not json', '"str"', ['outlook'], [], 7];

async function outcome(fn) {
    configReads = 0;
    try { return { ok: await fn(), reads: configReads }; }
    catch (e) { return { threw: e.constructor.name, reads: configReads }; }
}

function label(org, def) { return `org=${JSON.stringify(org)} default=${JSON.stringify(def)}`; }

test('runtime reading (integrationTools, palette, wizard, /auth/me): helper defaults match the inline code', async () => {
    for (const org of ORGS) for (const def of DEFAULTS) {
        globalDefaultsValue = def;
        const want = await outcome(() => oracleRuntime(org));
        const got = await outcome(() => resolveOrgAllowList(org));
        assert.deepStrictEqual(got, want, label(org, def));
    }
});

test('/auth/me: a parse failure still ends in its own catch (returns null there)', async () => {
    globalDefaultsValue = null;
    await assert.rejects(resolveOrgAllowList({ enabledIntegrations: 'not json' }), SyntaxError);
});

test('n8n diagnostics: list and source label match the inline code', async () => {
    for (const org of ORGS) for (const def of DEFAULTS) {
        globalDefaultsValue = def;
        const want = await outcome(() => oracleN8n(org));
        const got = await outcome(() => resolveOrgAllowListWithSource(org));
        assert.deepStrictEqual(got, want, label(org, def));
    }
});

test('featureAccessRoutes: present override, lenient parse, all ids when unset', async () => {
    for (const org of ORGS) for (const def of DEFAULTS) {
        globalDefaultsValue = def;
        const want = await outcome(() => oracleFeatureAccess(org));
        const got = await outcome(() => resolveOrgAllowList(org, {
            overrideWhen: 'present', parse: 'lenient', whenUnset: ALL_IDS.map(i => i),
        }));
        assert.deepStrictEqual(got, want, label(org, def));
    }
});

test('the global default is not read when the org overrides', async () => {
    globalDefaultsValue = ['outlook'];
    configReads = 0;
    await resolveOrgAllowList({ enabledIntegrations: ['gmail'] });
    await resolveOrgAllowList({ enabledIntegrations: '' }, { overrideWhen: 'present', parse: 'lenient' });
    assert.strictEqual(configReads, 0);
});

test('active set: matches the inline code for every store answer', async () => {
    const answers = [
        async () => ['gmail', 'n8n'],
        async () => [],
        async () => null,
        async () => { throw new Error('db down'); },
    ];
    for (const impl of answers) for (const isSuperAdmin of [false, true]) {
        activeImpl = impl;
        const want = await oracleActiveSet('org-1', isSuperAdmin);
        const got = await resolveOrgActiveSet('org-1', { bypass: isSuperAdmin });
        assert.deepStrictEqual(got, want);
    }
});

test('active set: a palette never consults it', async () => {
    let called = false;
    activeImpl = async () => { called = true; return ['gmail']; };
    assert.strictEqual(await resolveOrgActiveSet('org-1', { forPalette: true }), null);
    assert.strictEqual(called, false);
});
