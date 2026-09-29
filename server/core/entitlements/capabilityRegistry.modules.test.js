/**
 * Capability-registry module-filter seam tests.
 *
 * THE enforcement contract of the platform-module layer:
 *   - listCapabilities()/listByKind() OMIT capabilities of inactive modules
 *     (so every downstream projection — ceiling, matrices, /my-entitlements —
 *     inherits the filter), while
 *   - getCapability() stays UNFILTERED: requireCapability() resolves ids at
 *     middleware-factory/mount time and server/index.js mounts routes
 *     unconditionally — a filtered lookup would crash boot when the module is
 *     removed. This is the regression this file guards.
 *
 * Run: node --test core/capabilityRegistry.modules.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long';

// ── Mock ../db before anything loads (betaFeatures/stores require it) ──────
const dbPath = require.resolve('../../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    pool: { query: async () => ({ rows: [] }) },
    getRedis: () => null,
};
require.cache[dbPath].loaded = true;

const registry = require('./capabilityRegistry');
const { requireCapability } = require('./entitlements');

// The built-in module catalog now ships empty (Security Scan was ported to a
// downloadable .bfmod), so the module-filter seam is driven with a SYNTHETIC
// remote-module capability. The seam is agnostic to whether the owning module
// is built-in or remote: both project through the same _inactiveModuleCapIds
// filter, so this exercises the identical enforcement contract the built-in
// security_scan used to.
const MODULE_CAP = 'synthetic_module_cap';
const MODULE_ID = 'synthetic_module';
registry.setRemoteModuleCapabilityDescriptors([
    {
        id: MODULE_CAP,
        kind: 'beta',
        name: 'Synthetic Module Capability',
        description: '',
        category: 'Modules',
        licenseFeature: MODULE_CAP,
        lifecycle: 'beta',
        defaultState: 'off',
        userFacing: true,
        groupTogglable: true,
        moduleId: MODULE_ID,
        _remoteModule: true,
    },
]);

after(() => {
    // don't leak into a shared process
    registry.setInactiveModuleCapabilityIds(new Set());
    registry.setRemoteModuleCapabilityDescriptors([]);
});

test('baseline: a module capability is listed and stamped with its moduleId', () => {
    const cap = registry.getCapability(MODULE_CAP);
    assert.ok(cap, 'the module capability must exist in the registry');
    assert.strictEqual(cap.kind, 'beta');
    assert.strictEqual(cap.moduleId, MODULE_ID);
    assert.ok(registry.listCapabilities().some(c => c.id === MODULE_CAP));
    // non-modular capabilities carry moduleId: null. chat_basic is core and
    // is owned by no module by construction — notebooks used to serve as this
    // example but is now itself a built-in module surface.
    assert.strictEqual(registry.getCapability('chat_basic').moduleId, null);
});

test('inactive module ⇒ absent from listCapabilities()/listByKind()', () => {
    registry.setInactiveModuleCapabilityIds(new Set([MODULE_CAP]));
    assert.ok(!registry.listCapabilities().some(c => c.id === MODULE_CAP));
    assert.ok(!registry.listByKind('beta').some(c => c.id === MODULE_CAP));
});

test('getCapability() stays UNFILTERED while the module is inactive', () => {
    registry.setInactiveModuleCapabilityIds(new Set([MODULE_CAP]));
    const cap = registry.getCapability(MODULE_CAP);
    assert.ok(cap, 'getCapability must still resolve — mount-time lookups depend on it');
    assert.strictEqual(cap.id, MODULE_CAP);
});

test('requireCapability factory does not throw for an inactive-module capability', () => {
    registry.setInactiveModuleCapabilityIds(new Set([MODULE_CAP]));
    const gate = requireCapability(MODULE_CAP); // would crash boot if it threw
    assert.strictEqual(typeof gate, 'function');
});

test('clearing the set restores the capability in the projection', () => {
    registry.setInactiveModuleCapabilityIds(new Set());
    assert.ok(registry.listCapabilities().some(c => c.id === MODULE_CAP));
});

test('refreshModuleCapabilityFilter recomputes from module state (empty catalog ⇒ nothing inactive)', async () => {
    registry.setInactiveModuleCapabilityIds(new Set([MODULE_CAP]));
    // The built-in catalog is empty and the mocked db returns no platform_modules
    // rows ⇒ the recomputed inactive set is empty ⇒ the manual inactive marker
    // clears and the capability is listed again.
    require('../../modules/index').invalidateCache();
    await registry.refreshModuleCapabilityFilter();
    assert.ok(registry.listCapabilities().some(c => c.id === MODULE_CAP));
});
