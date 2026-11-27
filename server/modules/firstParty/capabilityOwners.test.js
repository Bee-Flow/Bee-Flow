'use strict';
/**
 * modules/firstParty/capabilityOwners.json against the tree, and absentCapabilities.js.
 *
 * The record is the core's copy of what each first-party module offers, so that a module that is
 * absent (its files not there) still loses its capabilities. It may not drift from the modules:
 *   - every composition's `capabilities` (firstParty/<id>.js) equals the record's ids of that
 *     module, and a module the record does not name declares none;
 *   - catalogModules are exactly the first-party modules the catalog (modules/catalog.js) knows,
 *     whose capability ids stay the catalog's: no id is claimed by a catalog module and the record;
 *   - every id of the record is a capability of the registry.
 * The compositions are read in a child process with every module visible, so the outcome is the
 * same when the suite runs in core mode.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OWNERS = require('./capabilityOwners.json');
const { absentModuleCapabilityIds, capabilitiesByModule } = require('./absentCapabilities');

const SERVER = path.resolve(__dirname, '..', '..');

/** @returns {Array<{ id: string, state: string, capabilities: string[] | null }>} every composition, with every module visible */
function compositions() {
    const code = [
        'const loader = require(process.argv[1]);',
        'const roots = require(process.argv[2]);',
        'const modules = loader.load({ log: { info() {}, warn() {}, error() {} } });',
        'process.stdout.write(JSON.stringify(modules.map((m) => ({ id: m.id, state: m.state,',
        '    capabilities: require(roots.treePath("firstParty", m.id + ".js")).capabilities || null }))));',
    ].join('\n');
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'BEEFLOW_HIDE_MODULES', 'BEEFLOW_MODULE_ROOTS', 'NODE_TEST_CONTEXT', 'BEEFLOW_EDITION', 'BEEFLOW_MODULES']) delete env[key];
    const roots = path.join(SERVER, 'moduleRoots.cjs');
    const r = spawnSync(process.execPath, ['--require', roots, '-e', code, path.join(__dirname, 'loader.js'), roots],
        { cwd: SERVER, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

/** @type {Record<string, string>} */
const RECORD = OWNERS.capabilities;
const sorted = (/** @type {Iterable<string>} */ ids) => [...ids].sort();

test('each composition declares exactly the capabilities the record gives its module', () => {
    const comps = compositions();
    assert.ok(comps.length >= 20, `only ${comps.length} compositions found`);
    for (const c of comps) {
        assert.equal(c.state, 'loaded', `${c.id} did not load`);
        const recorded = sorted(Object.keys(RECORD).filter((cap) => RECORD[cap] === c.id));
        assert.deepEqual(sorted(c.capabilities || []), recorded, `${c.id}: firstParty/${c.id}.js capabilities differ from capabilityOwners.json`);
    }
    const ids = new Set(comps.map((c) => c.id));
    for (const moduleId of new Set(Object.values(RECORD))) assert.ok(ids.has(moduleId), `the record names "${moduleId}", which has no composition`);
});

test('catalogModules are the first-party modules of the catalog, and no capability is claimed twice', () => {
    const { MODULES } = require('../catalog');
    const firstParty = new Set(compositions().map((c) => c.id));
    assert.deepEqual(sorted(OWNERS.catalogModules), sorted(MODULES.map((m) => m.id).filter((id) => firstParty.has(id))));
    /** @type {Map<string, string>} */
    const claimed = new Map();
    for (const m of MODULES) for (const cap of m.capabilityIds) claimed.set(cap, m.id);
    for (const [cap, moduleId] of Object.entries(RECORD)) {
        assert.ok(!claimed.has(cap), `${cap} is claimed by catalog module "${claimed.get(cap)}" and by "${moduleId}"`);
        assert.ok(!OWNERS.catalogModules.includes(moduleId), `${moduleId} is a catalog module; its capabilities are the catalog's`);
    }
});

test('every capability of the record is one the registry knows', () => {
    require('../../testUtils/routeHarness').recordDb();
    const registry = require('../../core/entitlements/capabilityRegistry');
    for (const cap of Object.keys(RECORD)) assert.ok(registry.getCapability(cap), `${cap} is not a capability`);
});

const CATALOG = (/** @type {string} */ id) => (id === 'apps' ? { capabilityIds: ['app_studio'] } : null);

test('an absent module offers nothing; a loaded or a failed one keeps its capabilities', () => {
    const states = /** @type {Record<string, string>} */ ({ apps: 'absent', int_google: 'absent', sanctions: 'failed' });
    const got = absentModuleCapabilityIds(CATALOG, { load: () => undefined, stateOf: (id) => states[id] || 'loaded' });
    const expected = ['app_studio', ...Object.keys(RECORD).filter((cap) => RECORD[cap] === 'int_google')];
    assert.deepEqual(sorted(got), sorted(expected));
});

test('every module present: nothing is left out', () => {
    const got = absentModuleCapabilityIds(CATALOG, { load: () => undefined, stateOf: () => 'loaded' });
    assert.equal(got.size, 0);
});

test('the loader decides first, and a loader that throws is the caller\'s to handle', () => {
    /** @type {string[]} */
    const calls = [];
    absentModuleCapabilityIds(CATALOG, { load: () => calls.push('load'), stateOf: (id) => { calls.push(id); return 'loaded'; } });
    assert.equal(calls[0], 'load');
    assert.throws(() => absentModuleCapabilityIds(CATALOG, { load: () => { throw new Error('no tree'); } }), /no tree/);
});

test('capabilitiesByModule takes a catalog module\'s ids from the catalog', () => {
    const byModule = capabilitiesByModule(CATALOG);
    assert.deepEqual(byModule.get('apps'), ['app_studio']);
    assert.deepEqual(byModule.get('automation'), []);
    assert.deepEqual(sorted(byModule.get('int_microsoft') || []), sorted(Object.keys(RECORD).filter((cap) => RECORD[cap] === 'int_microsoft')));
});
