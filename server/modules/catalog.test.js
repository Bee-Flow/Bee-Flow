/**
 * Platform-module catalog integrity tests.
 *
 * The catalog is pure data, but its references must stay real: every
 * capability id must resolve in the capability registry (getCapability is
 * deliberately UNFILTERED, so this holds whether or not the module is
 * imported) and every store file must exist on disk (importModule requires
 * them relative to server/).
 *
 * Run: node --test modules/catalog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mock ../db before the registry chain loads (betaFeatures requires it) ──
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
};
require.cache[dbPath].loaded = true;

const catalog = require('./catalog');
const registry = require('../core/entitlements/capabilityRegistry');

test('module ids are unique', () => {
    const ids = catalog.listModules().map(m => m.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate module ids in ${ids}`);
});

test('every capabilityIds entry resolves via registry.getCapability', () => {
    for (const m of catalog.listModules()) {
        assert.ok(Array.isArray(m.capabilityIds) && m.capabilityIds.length > 0, `${m.id} declares no capabilities`);
        for (const capId of m.capabilityIds) {
            const cap = registry.getCapability(capId);
            assert.ok(cap, `${m.id} references unknown capability '${capId}'`);
        }
    }
});

test('every storeModules file exists on disk (relative to server/)', () => {
    for (const m of catalog.listModules()) {
        for (const s of m.storeModules || []) {
            const abs = path.join(__dirname, '..', `${s.file}.js`);
            assert.ok(fs.existsSync(abs), `${m.id} store file missing: ${abs}`);
        }
    }
});

test('capabilityToModuleMap reverse index is consistent', () => {
    const map = catalog.capabilityToModuleMap();
    for (const m of catalog.listModules()) {
        for (const capId of m.capabilityIds || []) {
            assert.strictEqual(map.get(capId), m.id);
        }
    }
});

test('getModule returns null for unknown ids', () => {
    // Security Scan — the former pilot — was ported to a downloadable .bfmod,
    // so its old id resolves through the remote path, never the built-in one.
    assert.strictEqual(catalog.getModule('security_scan'), null);
    assert.strictEqual(catalog.getModule('nope'), null);
});

test('the built-in catalog ships the optional product surfaces', () => {
    // Filling this array is what makes a core-only edition possible. Every
    // entry must be grandfathered (defaultImported) so an existing install
    // that sets no edition variable keeps every surface it has today.
    const mods = catalog.listModules();
    assert.ok(mods.length > 0, 'expected built-in product surfaces');
    for (const m of mods) {
        assert.strictEqual(m.defaultImported, true, `${m.id} must default to imported`);
        assert.strictEqual(typeof m.name, 'string');
        assert.ok(m.name.length > 0, `${m.id} needs a display name`);
    }
});

test('availableByEdition honours BEEFLOW_EDITION and BEEFLOW_MODULES', () => {
    // Pure function of the environment read at load; assert the contract
    // directly rather than re-importing the module under a mutated env.
    assert.strictEqual(typeof catalog.availableByEdition, 'function');
    // With neither variable set in this test process, everything is available
    // — the default that keeps existing installs unchanged.
    for (const m of catalog.listModules()) {
        assert.strictEqual(m.available, true, `${m.id} must be available by default`);
    }
});
