/**
 * Platform-module runtime — REMOTE (Hub-downloaded) projection tests.
 *
 * Exercises modules/index.js against synthetic remote platform_modules rows
 * (settings.remote:true + a signed-manifest summary + a timestamp entitlement):
 *   - an imported-but-lapsed remote module projects status 'expired' and is
 *     inactive; its capability id lands in the inactive set (ceiling drop),
 *   - importModule() gates a lapsed paid module with `not_entitled` (→ 402),
 *   - importModule() on an entitled remote module delegates to
 *     packageLoader.activate (mocked), and removeModule() delegates to
 *     packageLoader.deactivate — never running the built-in store loop,
 *   - requireModule(id, { remote:true }) does NOT throw for a non-catalog id
 *     and 404-conceals while inactive.
 *
 * Everything mocked via require.cache — no Postgres, no real package loader.
 *
 * Run: node --test modules/moduleRegistry.remote.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

mock('../db', {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});

// Built-in catalog has NO remote ids (remote lives only in the state store).
mock('./catalog', {
    MODULES: [],
    listModules: () => [],
    getModule: () => null,
    capabilityToModuleMap: () => new Map(),
});

const SECONDS = (deltaMs) => Math.floor((Date.now() + deltaMs) / 1000);
function remoteRow(id, { exp, status = 'imported', cap } = {}) {
    return {
        moduleId: id,
        status,
        version: '1.0.0',
        settings: {
            remote: true,
            manifest: {
                id, name: `Mod ${id}`, version: '1.0.0', description: '', category: 'Modules', icon: 'box',
                capabilities: [{ id: cap, kind: 'integration' }],
            },
            entitlement: { kind: 'subscription', status: 'active', exp },
            package: { version: '1.0.0', sha256: 's', kid: 'k' },
        },
    };
}

const stateRows = new Map();
mock('../stores/platformModuleStore', {
    initDB: async () => {},
    getAllStates: async () => [...stateRows.values()].map(r => ({ ...r })),
    getState: async (id) => (stateRows.get(id) ? { ...stateRows.get(id) } : null),
    setImported: async (id, { actorId = null, version = null } = {}) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'imported', version, importedBy: actorId };
        stateRows.set(id, row); return { ...row };
    },
    setRemoved: async (id, { actorId = null } = {}) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'removed', removedBy: actorId };
        stateRows.set(id, row); return { ...row };
    },
});

mock('../stores/userStore', { logAccessAudit: async () => {} });
mock('../auth/sessionCache', { bustSessionsForUser: async () => 1, bustSessionsForOrg: async () => 0 });

// packageLoader — activate/deactivate spies (avoid loading the real loader).
// Mirror the real loader's cache-invalidation side effect so the runtime's
// TTL state cache reflects the flip before removeModule/importModule re-project.
const loaderCalls = [];
mock('./packageLoader', {
    activate: async (id, version) => {
        loaderCalls.push(['activate', id, version]);
        stateRows.get(id).status = 'imported';
        require('./index').invalidateCache();
        return { ok: true };
    },
    deactivate: async (id) => {
        loaderCalls.push(['deactivate', id]);
        if (stateRows.get(id)) stateRows.get(id).status = 'removed';
        require('./index').invalidateCache();
        return { ok: true };
    },
});

const modules = require('./index');

function fakeRes() {
    return {
        statusCode: null, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}

beforeEach(() => {
    modules.invalidateCache();
    stateRows.clear();
    loaderCalls.length = 0;
});

test('imported-but-lapsed remote module ⇒ inactive, status "expired"', async () => {
    stateRows.set('crm_exp', remoteRow('crm_exp', { exp: SECONDS(-90_000_000), cap: 'crm_exp_cap' }));
    assert.strictEqual(await modules.isModuleActive('crm_exp'), false);
    const rows = await modules.listModulesWithStatus();
    const row = rows.find(r => r.id === 'crm_exp');
    assert.ok(row, 'remote row projected in listing');
    assert.strictEqual(row.remote, true);
    assert.strictEqual(row.status, 'expired');
});

test('entitled remote module ⇒ active', async () => {
    stateRows.set('crm_ok', remoteRow('crm_ok', { exp: SECONDS(3600_000), cap: 'crm_ok_cap' }));
    assert.strictEqual(await modules.isModuleActive('crm_ok'), true);
    const row = (await modules.listModulesWithStatus()).find(r => r.id === 'crm_ok');
    assert.strictEqual(row.status, 'imported');
});

test('listInactiveCapabilityIds includes lapsed remote caps, excludes active ones', async () => {
    stateRows.set('crm_exp', remoteRow('crm_exp', { exp: SECONDS(-90_000_000), cap: 'crm_exp_cap' }));
    stateRows.set('crm_ok', remoteRow('crm_ok', { exp: SECONDS(3600_000), cap: 'crm_ok_cap' }));
    const inactive = await modules.listInactiveCapabilityIds();
    assert.ok(inactive.has('crm_exp_cap'), 'lapsed remote cap is inactive');
    assert.ok(!inactive.has('crm_ok_cap'), 'entitled remote cap is active');
});

test('importModule gates a lapsed paid remote module with not_entitled (→402)', async () => {
    stateRows.set('crm_exp', remoteRow('crm_exp', { exp: SECONDS(-90_000_000), status: 'removed', cap: 'crm_exp_cap' }));
    const r = await modules.importModule('crm_exp', { actorId: 'admin1' });
    assert.deepStrictEqual(r, { ok: false, error: 'not_entitled' });
    assert.strictEqual(loaderCalls.length, 0, 'must not activate an unentitled module');
});

test('importModule on an entitled remote module delegates to packageLoader.activate', async () => {
    stateRows.set('crm_ok', remoteRow('crm_ok', { exp: SECONDS(3600_000), status: 'removed', cap: 'crm_ok_cap' }));
    const r = await modules.importModule('crm_ok', { actorId: 'admin1' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(loaderCalls[0], ['activate', 'crm_ok', '1.0.0']);
});

test('removeModule on a remote module delegates to packageLoader.deactivate', async () => {
    stateRows.set('crm_ok', remoteRow('crm_ok', { exp: SECONDS(3600_000), cap: 'crm_ok_cap' }));
    const r = await modules.removeModule('crm_ok', { actorId: 'admin1' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(loaderCalls[0], ['deactivate', 'crm_ok']);
    assert.strictEqual(r.module.status, 'removed');
});

test('requireModule(id, { remote:true }) does not throw and 404-conceals while inactive', async () => {
    // no row at all ⇒ inactive
    const gate = modules.requireModule('ghost_remote', { remote: true });
    let res = fakeRes(); let nextCalled = false;
    await gate({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'not_found' });

    // entitled + imported ⇒ next()
    stateRows.set('crm_ok', remoteRow('crm_ok', { exp: SECONDS(3600_000), cap: 'crm_ok_cap' }));
    modules.invalidateCache();
    const gate2 = modules.requireModule('crm_ok', { remote: true });
    res = fakeRes(); nextCalled = false;
    await gate2({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);
});

test('requireModule without remote flag still throws for an unknown id', () => {
    assert.throws(() => modules.requireModule('not_a_catalog_id'), /unknown module/);
});
