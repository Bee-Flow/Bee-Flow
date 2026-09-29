/**
 * Platform-module runtime tests (server/modules/index.js).
 *
 * Covers the activation state machine against a SYNTHETIC catalog:
 *   - grandfathering: no platform_modules row + defaultImported:true ⇒ active
 *   - explicit 'removed' row ⇒ inactive; re-import ⇒ active again
 *   - available:false ⇒ never active and never importable (module_unavailable)
 *   - store read failure ⇒ catalog-default fallback (grandfathered fail OPEN)
 *   - importModule runs the module's store initDB FIRST and aborts on failure
 *   - audit + session-bust side effects, and the requireModule() 404 gate
 *
 * Everything is mocked via require.cache (same style as
 * core/capabilityRegistry.customIntegrations.test.js) — no Postgres.
 *
 * Run: node --test modules/moduleRegistry.test.js
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

// ── Mock ../db (registry chain: betaFeatures requires it) ──────────────────
mock('../db', {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});

// ── Synthetic catalog (mocked at the real ./catalog path so the registry's
//    lazy moduleId stamping sees the same data) ───────────────────────────
const CATALOG = [
    {
        id: 'mod_grand', name: 'Grandfathered Module', icon: 'shield', category: 'Studio',
        version: '1.0.0', description: 'row-absent means imported',
        available: true, defaultImported: true,
        capabilityIds: ['cap_grand'],
        // Store file is fictional-by-reference: it only needs to RESOLVE on disk
        // so importModule can require it — the real module code is replaced by the
        // initDB spy mock below. reminderStore is an arbitrary existing store the
        // module runtime never otherwise loads.
        storeModules: [{ name: 'grandStore', file: './stores/reminderStore' }],
        requirements: { docker: true, images: ['img-x'], env: ['X_*'] },
    },
    {
        id: 'mod_unavail', name: 'Unavailable Module', icon: 'box', category: 'Studio',
        version: '0.1.0', description: 'not on this deployment',
        available: false, defaultImported: true,
        capabilityIds: ['cap_unavail'],
        storeModules: [],
    },
];
mock('./catalog', {
    MODULES: CATALOG,
    listModules: () => CATALOG,
    getModule: (id) => CATALOG.find(m => m.id === id) || null,
    capabilityToModuleMap: () => new Map(CATALOG.flatMap(m => (m.capabilityIds || []).map(c => [c, m.id]))),
});

// ── In-memory platformModuleStore ───────────────────────────────────────────
const stateRows = new Map(); // moduleId → store row
let storeFail = false;
mock('../stores/platformModuleStore', {
    initDB: async () => {},
    getAllStates: async () => {
        if (storeFail) throw new Error('db down');
        return [...stateRows.values()].map(r => ({ ...r }));
    },
    getState: async (id) => {
        if (storeFail) throw new Error('db down');
        return stateRows.get(id) ? { ...stateRows.get(id) } : null;
    },
    setImported: async (id, { actorId = null, version = null } = {}) => {
        if (storeFail) throw new Error('db down');
        const row = { moduleId: id, status: 'imported', version, importedAt: new Date().toISOString(), importedBy: actorId, removedAt: null, removedBy: null };
        stateRows.set(id, row);
        return { ...row };
    },
    setRemoved: async (id, { actorId = null } = {}) => {
        if (storeFail) throw new Error('db down');
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'removed', removedAt: new Date().toISOString(), removedBy: actorId };
        stateRows.set(id, row);
        return { ...row };
    },
});

// ── The module's store file (initDB spy; mocked at the path the catalog's
//    storeModules entry resolves to) ────────────────────────────────────────
let initDbCalls = 0;
let initDbFail = false;
mock('../stores/reminderStore', {
    initDB: async () => {
        initDbCalls++;
        if (initDbFail) throw new Error('migration boom');
    },
});

// ── Audit + session-bust spies ──────────────────────────────────────────────
const auditCalls = [];
mock('../stores/userStore', {
    logAccessAudit: async (...args) => { auditCalls.push(args); },
});
const bustCalls = [];
mock('../auth/sessionCache', {
    bustSessionsForUser: async (userId) => { bustCalls.push(userId); return 1; },
    bustSessionsForOrg: async () => 0,
});

const modules = require('./index');
const registry = require('../core/entitlements/capabilityRegistry');

function fakeRes() {
    return {
        statusCode: null, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}

beforeEach(() => {
    modules.invalidateCache();
    storeFail = false;
    initDbFail = false;
});

test('grandfathering: no row + defaultImported:true ⇒ active', async () => {
    stateRows.clear();
    assert.strictEqual(await modules.isModuleActive('mod_grand'), true);
    const rows = await modules.listModulesWithStatus();
    const grand = rows.find(r => r.id === 'mod_grand');
    assert.strictEqual(grand.status, 'imported');
    assert.strictEqual(grand.source, 'default');
    assert.strictEqual(grand.importedAt, null);
    assert.strictEqual(grand.importedBy, null);
    // wire-contract shape spot checks
    assert.ok(Array.isArray(grand.requirements) && grand.requirements.length === 3);
    assert.strictEqual(typeof grand.requirementsMet, 'boolean');
    assert.deepStrictEqual(grand.capabilities.map(c => c.id), ['cap_grand']);
});

test('explicit removed row ⇒ inactive; capability lands in the inactive set', async () => {
    stateRows.clear();
    const r = await modules.removeModule('mod_grand', { actorId: 'admin1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.module.status, 'removed');
    assert.strictEqual(r.module.source, 'explicit');
    assert.strictEqual(await modules.isModuleActive('mod_grand'), false);
    const inactive = await modules.listInactiveCapabilityIds();
    assert.ok(inactive.has('cap_grand'));
    // audit + session bust fired
    const audit = auditCalls[auditCalls.length - 1];
    assert.strictEqual(audit[0], 'platform.module.remove');
    assert.strictEqual(audit[1], 'platform_module');
    assert.strictEqual(audit[2], 'mod_grand');
    assert.strictEqual(audit[3], 'admin1');
    assert.deepStrictEqual(audit[4], { status: 'imported' }); // grandfathered before-image
    assert.deepStrictEqual(audit[5], { status: 'removed' });
    assert.strictEqual(bustCalls[bustCalls.length - 1], 'admin1');
});

test('re-import ⇒ active again; runs the store initDB first', async () => {
    // state carried over from the previous test: mod_grand removed
    const callsBefore = initDbCalls;
    const r = await modules.importModule('mod_grand', { actorId: 'admin1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.module.status, 'imported');
    assert.strictEqual(r.module.source, 'explicit');
    assert.strictEqual(r.module.importedBy, 'admin1');
    assert.strictEqual(initDbCalls, callsBefore + 1);
    assert.strictEqual(await modules.isModuleActive('mod_grand'), true);
    const inactive = await modules.listInactiveCapabilityIds();
    assert.ok(!inactive.has('cap_grand'));
    const audit = auditCalls[auditCalls.length - 1];
    assert.strictEqual(audit[0], 'platform.module.import');
    assert.deepStrictEqual(audit[4], { status: 'removed' });
    assert.deepStrictEqual(audit[5], { status: 'imported' });
});

test('store initDB failure aborts the import (no state write)', async () => {
    stateRows.delete('mod_grand');
    initDbFail = true;
    await assert.rejects(() => modules.importModule('mod_grand', { actorId: 'admin1' }), /migration boom/);
    assert.strictEqual(stateRows.has('mod_grand'), false, 'state row must not be written on aborted import');
});

test('available:false ⇒ never active, never importable', async () => {
    assert.strictEqual(await modules.isModuleActive('mod_unavail'), false);
    // …even with a forced imported row
    stateRows.set('mod_unavail', { moduleId: 'mod_unavail', status: 'imported', importedAt: new Date().toISOString(), importedBy: 'x' });
    modules.invalidateCache();
    assert.strictEqual(await modules.isModuleActive('mod_unavail'), false);
    const r = await modules.importModule('mod_unavail', { actorId: 'admin1' });
    assert.deepStrictEqual(r, { ok: false, error: 'module_unavailable' });
    const rows = await modules.listModulesWithStatus();
    assert.strictEqual(rows.find(x => x.id === 'mod_unavail').status, 'unavailable');
    stateRows.delete('mod_unavail');
});

test('unknown module id ⇒ not_found / factory throw', async () => {
    assert.deepStrictEqual(await modules.importModule('nope', {}), { ok: false, error: 'not_found' });
    assert.deepStrictEqual(await modules.removeModule('nope', {}), { ok: false, error: 'not_found' });
    assert.throws(() => modules.requireModule('nope'), /unknown module/);
});

test('store read failure with cold cache ⇒ catalog default (grandfathered fails open)', async () => {
    // A removed row exists, but the store is down and the cache is cold:
    // row-absent semantics apply ⇒ defaultImported wins.
    stateRows.set('mod_grand', { moduleId: 'mod_grand', status: 'removed', removedAt: new Date().toISOString(), removedBy: 'x' });
    modules.invalidateCache();
    storeFail = true;
    assert.strictEqual(await modules.isModuleActive('mod_grand'), true);
    // and once the store recovers, the explicit row governs again
    storeFail = false;
    modules.invalidateCache();
    assert.strictEqual(await modules.isModuleActive('mod_grand'), false);
    stateRows.delete('mod_grand');
});

test('refreshModuleActivations pushes the inactive set into the registry', async () => {
    stateRows.set('mod_grand', { moduleId: 'mod_grand', status: 'removed' });
    modules.invalidateCache();
    const inactive = await modules.refreshModuleActivations();
    assert.ok(inactive.has('cap_grand') && inactive.has('cap_unavail'));
    stateRows.delete('mod_grand');
    modules.invalidateCache();
    const inactive2 = await modules.refreshModuleActivations();
    assert.ok(!inactive2.has('cap_grand'));
    assert.ok(inactive2.has('cap_unavail')); // available:false stays inactive
    // sanity: the push landed in the registry (no throw, list still coherent)
    assert.ok(Array.isArray(registry.listCapabilities()));
});

test('requireModule middleware: active ⇒ next(), inactive ⇒ 404 concealment', async () => {
    stateRows.delete('mod_grand');
    modules.invalidateCache();
    const gate = modules.requireModule('mod_grand');

    let nextCalled = false;
    let res = fakeRes();
    await gate({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);

    await modules.removeModule('mod_grand', { actorId: 'admin1' });
    nextCalled = false;
    res = fakeRes();
    await gate({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'not_found' });
});
