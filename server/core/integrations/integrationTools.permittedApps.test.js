/**
 * getUserPermittedApps vs isIntegrationPermittedForUser — the distinction that
 * a stubbed unit test cannot see.
 *
 * getUserPermittedApps intersects the gate with TOOL_REGISTRY, because it
 * answers "what may I OFFER in a palette" and an app with no tools array has
 * nothing to offer. That makes it structurally incapable of returning an
 * integration registered inline rather than as a TOOLS-array module —
 * `browser-fetch` (browse_web) being the one that matters.
 *
 * App Studio's ai_browse step authorised on `permitted.has('browser-fetch')`.
 * It was refused for every user on every deployment, whatever the org had
 * granted, and every test passed: they all stubbed getUserPermittedApps to
 * return a set containing a value it can never contain.
 *
 * So both helpers are RUN here, against the real registry and the real gate,
 * with only the config/entitlement stores stubbed: the gap between them is
 * measured rather than described, and the browse step is driven far enough to
 * show which of the two it asks. The store graph that comes with
 * integrationTools logs connection errors on require — harmless, and the
 * reason this file needs --test-force-exit like every other.
 *
 * Run: cd server && node --test --test-force-exit core/integrations/integrationTools.permittedApps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── The two stores the gate reads, stubbed; everything else is real ────
// `null` from configStore is the "nothing switched off" answer, so the gate
// falls through to its org/group layers with an empty org — the shape a
// consumer account has, and the widest the gate ever opens.
const csPath = require.resolve('../../stores/configStore');
require.cache[csPath] = {
    id: csPath, filename: csPath, loaded: true,
    exports: { getConfig: async () => null, getAllConfig: async () => ({}) },
};
const entPath = require.resolve('../entitlements/entitlements');
require.cache[entPath] = {
    id: entPath, filename: entPath, loaded: true,
    exports: { resolveEntitlements: async () => ({ degraded: true, effective: { integration: [] } }) },
};

const { TOOL_REGISTRY, ALL_TOOL_APPS } = require('../../automation/toolRegistry');
const { listByKind } = require('../entitlements/capabilityRegistry');
const { getUserPermittedApps, isIntegrationPermittedForUser } = require('./integrationTools');

const registryApps = new Set(TOOL_REGISTRY.map((e) => e.app));
const USER = { userId: 'u1', session: { user: { id: 'u1' } }, isAdmin: false };

test('browse_web is NOT a TOOL_REGISTRY module — the fact the whole bug rests on', () => {
    assert.ok(!registryApps.has('browser-fetch'),
        'if browse_web ever becomes a registry module, revisit browseStep.js gate 2');
    // Since A2-1 `browser-fetch` IS in `ALL_TOOL_APPS` — the shared list the
    // agent's tool picker and the permission layer's attribution index both
    // read. Deliberately a different list: TOOL_REGISTRY answers "what may a
    // palette offer", and that answer must stay as it is.
    assert.ok(ALL_TOOL_APPS.some((e) => e.app === 'browser-fetch'),
        'the picker must be able to show browse_web — otherwise it never records a refusal for it');
});

test('the palette helper cannot return browser-fetch, while the single-app check grants it', async () => {
    const permitted = await getUserPermittedApps(USER);
    assert.ok(permitted instanceof Set && permitted.size > 0, 'the gate answered nothing at all');
    assert.ok(!permitted.has('browser-fetch'),
        'getUserPermittedApps returned browser-fetch — if that is now possible, browseStep gate 2 can be simplified');

    assert.strictEqual(
        await isIntegrationPermittedForUser({ userId: 'u1', appId: 'browser-fetch', session: USER.session }), true,
        'the single-app check must grant what the gate allows, registry module or not',
    );
});

test('everything the palette offers is also granted by the single-app check', async () => {
    // One shared gate, so the two can never disagree in this direction. The
    // reverse direction is the bug's shape and has its own case below.
    const permitted = await getUserPermittedApps(USER);
    const integrations = new Set(listByKind('integration').map((c) => c.id));

    for (const appId of permitted) {
        if (!integrations.has(appId)) continue; // palette-only ids are not integrations
        assert.strictEqual(
            await isIntegrationPermittedForUser({ userId: 'u1', appId, session: USER.session }), true,
            `${appId} is offered by the palette but refused by the single-app check — the two gates have drifted apart`,
        );
    }
});

test('the inline-registered integrations are granted, and invisible to the palette', async () => {
    // Every app a caller could wrongly authorise through the palette helper.
    // The old version of this file read them off a module-private constant;
    // each is now checked by asking both helpers. `google-maps` and
    // `music-gen` appear in no public list at all, which is why they are
    // named here rather than discovered.
    const permitted = await getUserPermittedApps(USER);
    for (const appId of ['browser-fetch', 'google-maps', 'music-gen', 'workspace', 'presentations', 'regex-generator']) {
        assert.ok(!registryApps.has(appId), `${appId} joined TOOL_REGISTRY — the palette can offer it now`);
        assert.ok(!permitted.has(appId), `${appId} is suddenly in the palette result`);
        assert.strictEqual(
            await isIntegrationPermittedForUser({ userId: 'u1', appId, session: USER.session }), true,
            `${appId} must be reachable through the single-app check — nothing else can authorise it`,
        );
    }
});

test('no app discoverable from a public list has quietly joined that gap', async () => {
    // The ratchet: a NEW integration registered inline rather than as a
    // TOOLS-array module shows up here, and whoever added it has to decide
    // which helper its callers must ask.
    const permitted = await getUserPermittedApps(USER);
    const candidates = new Set([
        ...ALL_TOOL_APPS.map((e) => e.app),
        ...TOOL_REGISTRY.map((e) => e.app),
        ...listByKind('integration').map((c) => c.id),
    ].filter(Boolean));

    const invisible = [];
    for (const appId of candidates) {
        if (permitted.has(appId) || registryApps.has(appId)) continue;
        if (await isIntegrationPermittedForUser({ userId: 'u1', appId, session: USER.session })) invisible.push(appId);
    }
    assert.deepStrictEqual(invisible.sort(), ['browser-fetch', 'music-gen', 'presentations', 'regex-generator', 'workspace'],
        'a change to this set is a change to which apps a palette can offer — deliberate, not incidental');
});

test('the single-app check refuses rather than failing open', async () => {
    assert.strictEqual(await isIntegrationPermittedForUser({ userId: null, appId: 'browser-fetch' }), false);
    assert.strictEqual(await isIntegrationPermittedForUser({ userId: 'u1', appId: null }), false);
    assert.strictEqual(await isIntegrationPermittedForUser({}), false);
});

test('the App Studio browse step passes the integration gate it claims to read', async (t) => {
    // Gate 3 (the browsing backend) would otherwise decide the answer for us.
    const pwtPath = require.resolve('../../services/pwtRunner');
    const saved = require.cache[pwtPath];
    require.cache[pwtPath] = {
        id: pwtPath, filename: pwtPath, loaded: true,
        exports: { dockerAvailable: async () => false },
    };
    const savedEndpoint = process.env.BROWSER_WS_ENDPOINT;
    delete process.env.BROWSER_WS_ENDPOINT;
    t.after(() => {
        if (saved) require.cache[pwtPath] = saved; else delete require.cache[pwtPath];
        if (savedEndpoint !== undefined) process.env.BROWSER_WS_ENDPOINT = savedEndpoint;
    });

    const { executeBrowseStep } = require('../../appStudio/browseStep');
    const run = (aiBrowsing) => executeBrowseStep(
        { userId: 'u1', organizationId: null },
        { aiBrowsing },
        { task: 'find the refund policy' },
        { browse: {} },
        { resolveBinding: (b) => b, buildServerScope: () => ({}) },
    );

    const out = await run({ enabled: true });
    assert.notStrictEqual(out.code, 'browse_disabled',
        'the step asked the palette helper again — it can never see browser-fetch, so the step could never run');
    assert.strictEqual(out.code, 'browse_no_backend', 'the integration gate passed; only the backend probe should stop it');

    // And the human opt-in still comes first.
    assert.strictEqual((await run({ enabled: false })).code, 'browse_not_enabled');
    assert.strictEqual((await run(undefined)).code, 'browse_not_enabled');
});
