/**
 * modules/firstParty/loader.js on a fixture tree with two roots, through the real resolver
 * (testUtils/moduleRootsFixture.testkit.js): a composition is found in the core root and in a
 * module root alike, its part files are merged through the tree, and core mode
 * (BEEFLOW_HIDE_MODULES) hides a composition, so its module is absent and what requires it fails.
 *
 * The fixture's scripts/module-map.mjs is a stand-in for the ownership map: firstParty/m1* and
 * firstParty/m3* belong to m1 and m3 although they still sit in the core root.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildFixture, runProbe } = require('../../testUtils/moduleRootsFixture.testkit');

const LOADER_FILES = ['loader.js', 'loaderRules.js', 'parts.js', 'moduleState.js', 'order.json'];
// Spelled as data: the fixture's own requests, relative to its firstParty/ directory.
const PARTS_REQUEST = ['..', 'modules', 'firstParty', 'parts'].join('/');

/**
 * @param {string} id
 * @param {string[]} requires
 */
const composition = (id, requires) => [
    `const { withParts } = require(${JSON.stringify(PARTS_REQUEST)});`,
    `module.exports = withParts({ id: ${JSON.stringify(id)}, requires: ${JSON.stringify(requires)}, uses: [] });`,
].join('\n');

const FILES = {
    'scripts/module-map.mjs': [
        'export function loadModuleMap() {',
        '    const owner = (p) => (/^firstParty\\/(m1|m3)[.]/.exec(p) || [])[1] || null;',
        '    return { ownerOf: (pkg, treePath) => (pkg === "server" ? owner(treePath) : null) };',
        '}',
    ].join('\n'),
    'core/firstParty/m1.js': composition('m1', []),
    'core/firstParty/m1.mounts.js': 'module.exports = { mounts: [{ key: "m1:/api/m1", slot: "main", path: "/api/m1", handlers: () => [() => {}] }] };',
    'core/firstParty/m3.js': composition('m3', []),
    'modules/m2/server/firstParty/m2.js': composition('m2', ['m1']),
    'modules/m2/server/firstParty/m2.stores.js': 'module.exports = { stores: [{ name: "m2Store", file: "./stores/m2Store" }] };',
};

/** @type {ReturnType<typeof buildFixture>} */
let fx;
before(() => {
    fx = buildFixture(FILES);
    const target = path.join(fx.core, 'modules', 'firstParty');
    fs.mkdirSync(target, { recursive: true });
    for (const name of LOADER_FILES) fs.copyFileSync(path.join(__dirname, name), path.join(target, name));
});
after(() => fx.remove());

/**
 * Load on the fixture and report modules(), the mount keys and the store names.
 * @param {string} name
 * @param {Record<string, string>} env
 */
function loadIn(name, env) {
    const code = [
        'const loader = require(require("node:path").join(require("node:path").dirname(ROOTS_LIB), "modules", "firstParty", "loader.js"));',
        'const log = { info() {}, warn() {}, error() {} };',
        'const mods = loader.load({ catalog: { isModuleAvailable: () => true }, log });',
        'const app = { keys: [], use(p) { this.keys.push(p); } };',
        'loader.mount(app, {}, "main");',
        'out({ mods: mods.map((m) => [m.id, m.state, m.detail || ""]), mounts: app.keys, stores: loader.stores().map((s) => s.name) });',
    ].join('\n');
    const r = runProbe(fx, name, code, { env });
    assert.strictEqual(r.status, 0, `probe ${name} failed:\n${r.stderr}`);
    return r.value;
}

describe('the loader on a fixture tree', () => {
    test('finds the compositions in the core root and in a module root, with their parts', () => {
        assert.deepStrictEqual(loadIn('all', {}), {
            mods: [['m1', 'loaded', ''], ['m2', 'loaded', ''], ['m3', 'loaded', '']],
            mounts: ['/api/m1'],
            stores: ['m2Store'],
        });
    });

    test('core mode hides m1: m1 is absent, m2 (which requires it) fails, m3 loads', () => {
        assert.deepStrictEqual(loadIn('hideM1', { BEEFLOW_HIDE_MODULES: 'm1' }), {
            mods: [['m2', 'failed', 'it requires "m1", which is absent'], ['m3', 'loaded', '']],
            mounts: [],
            stores: [],
        });
    });

    test('core mode with all modules hidden: the loader sees no module at all', () => {
        assert.deepStrictEqual(loadIn('hideAll', { BEEFLOW_HIDE_MODULES: 'all' }), { mods: [], mounts: [], stores: [] });
    });
});
