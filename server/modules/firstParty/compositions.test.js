/**
 * The compositions of the real tree (firstParty/<id>.js): one per module of
 * scripts/module-map.json, with the same requires and uses (one source of truth later; until
 * then they may not drift), and the loader finds exactly those, all loaded. Besides its id,
 * requires and uses a composition holds only what its part files add (modules/firstParty/parts.js).
 * Every store and migration a module contributes is named in the core's order index and is no
 * longer in the core's own list, and no module contributes Dutch catalogues (they stay one core
 * list, boot/bootMigrations.js).
 *
 * Loading the compositions and registering the modules loads nothing but the compositions, the
 * loader's own files and the resolver: every test process does both in its preload
 * (testUtils/registerFeatures.js), and a file loaded there is in the require cache before a test
 * has put its doubles in. A part file requires what a row needs inside that row.
 *
 * Runs the loader in a child process with every module visible (no BEEFLOW_HIDE_MODULES), so
 * the outcome is the same when the suite itself runs in core mode.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..', '..');
const MAP = JSON.parse(fs.readFileSync(path.join(SERVER, '..', 'scripts', 'module-map.json'), 'utf8'));
const { PART_KEYS } = require('./parts');
const ALLOWED_KEYS = new Set(['id', 'requires', 'uses', 'capabilities', ...Object.values(PART_KEYS).flat()]);
const ORDER = require('./order.json');

/** load() on the real tree, and the keys of each composition, from a clean child process. */
function loadRealTree() {
    const code = [
        'const loader = require(process.argv[1]);',
        'const log = { info() {}, warn() {}, error: (...a) => process.stderr.write(a.join(" ") + "\\n") };',
        'const modules = loader.load({ log });',
        'const roots = require(process.argv[2]);',
        'const keys = Object.fromEntries(modules.map((m) => [m.id, Object.keys(require(roots.treePath("firstParty", m.id + ".js"))).sort()]));',
        'loader.register();',
        'const loaded = Object.keys(require.cache).map((f) => roots.toTreePath(f) || f).sort();',
        'process.stdout.write(JSON.stringify({ modules, keys, loaded, stores: loader.stores(), migrations: loader.migrations(), nlTranslations: loader.nlTranslations() }));',
    ].join('\n');
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'BEEFLOW_HIDE_MODULES', 'BEEFLOW_MODULE_ROOTS', 'NODE_TEST_CONTEXT', 'BEEFLOW_EDITION', 'BEEFLOW_MODULES']) delete env[key];
    const roots = path.join(SERVER, 'moduleRoots.cjs');
    const r = spawnSync(process.execPath, ['--require', roots, '-e', code, path.join(__dirname, 'loader.js'), roots],
        { cwd: SERVER, env, encoding: 'utf8', timeout: 30_000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

test('every module of scripts/module-map.json has a composition, all loaded, requires and uses equal', () => {
    const got = loadRealTree();
    const ids = Object.keys(MAP.modules).sort();
    assert.deepStrictEqual(got.modules.map((/** @type {{ id: string }} */ m) => m.id), ids);
    for (const m of got.modules) {
        assert.strictEqual(m.state, 'loaded', `${m.id}: ${m.detail}`);
        assert.deepStrictEqual(m.requires, MAP.modules[m.id].requires, `${m.id}: requires differ from scripts/module-map.json`);
        assert.deepStrictEqual(m.uses, MAP.modules[m.id].uses, `${m.id}: uses differ from scripts/module-map.json`);
        assert.deepStrictEqual(got.keys[m.id].filter((/** @type {string} */ k) => !ALLOWED_KEYS.has(k)), [], `${m.id}: the composition holds a key no part file may add`);
        for (const k of ['id', 'requires', 'uses']) assert.ok(got.keys[m.id].includes(k), `${m.id}: no ${k}`);
    }
    const coreStores = new Set(require('../../storeModules').STORE_MODULES.map((/** @type {{ name: string }} */ s) => s.name));
    const coreLoose = new Set(require('../../boot/bootMigrations').CORE_LOOSE_MIGRATIONS);
    for (const { name } of got.stores) {
        assert.ok(ORDER.stores.includes(name) && !coreStores.has(name), `store ${name}: not in order.json "stores", or also in the core's list`);
    }
    for (const name of got.migrations) {
        assert.ok(ORDER.migrations.includes(name) && !coreLoose.has(name), `migration ${name}: not in order.json "migrations", or also in the core's list`);
    }
    assert.deepStrictEqual(got.nlTranslations, [], 'a module declares Dutch catalogues; they stay in boot/bootMigrations.js NL_TRANSLATIONS');
});

/** What listing and registering the modules may load: the compositions, the loader's files, the resolver. */
const LIGHT = [/^firstParty\//, /^modules\/firstParty\//, /^modules\/roots\//, /^moduleRoots\.cjs$/, /^modules\/catalog\.js$/];

test('loading and registering the modules loads only the compositions, the loader and the resolver', () => {
    const { loaded } = loadRealTree();
    assert.ok(loaded.length >= 60, `only ${loaded.length} files loaded: the child did not load the compositions`);
    const heavy = loaded.filter((/** @type {string} */ f) => !LIGHT.some((p) => p.test(f)));
    assert.deepStrictEqual(heavy, [],
        'a composition part requires a file at load, or register() loads one outside an open channel; require it inside the row instead (the log: modules/firstParty/partLog.js)');
});
