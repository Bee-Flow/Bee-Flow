/**
 * The compositions of the real tree (firstParty/<id>.js): one per module of
 * scripts/module-map.json, with the same requires and uses (one source of truth later; until
 * then they may not drift), and the loader finds exactly those, all loaded. Each one holds its
 * id, requires and uses, plus what its part files (modules/firstParty/parts.js) add.
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
const PART_KEYS = Object.values(require('./parts').PART_KEYS).flat();
const MAP = JSON.parse(fs.readFileSync(path.join(SERVER, '..', 'scripts', 'module-map.json'), 'utf8'));

/** load() on the real tree, and the keys of each composition, from a clean child process. */
function loadRealTree() {
    const code = [
        'const loader = require(process.argv[1]);',
        'const log = { info() {}, warn() {}, error: (...a) => process.stderr.write(a.join(" ") + "\\n") };',
        'const modules = loader.load({ log });',
        'const roots = require(process.argv[2]);',
        'const keys = Object.fromEntries(modules.map((m) => [m.id, Object.keys(require(roots.treePath("firstParty", m.id + ".js"))).sort()]));',
        'process.stdout.write(JSON.stringify({ modules, keys, stores: loader.stores(), migrations: loader.migrations() }));',
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

test('every module of scripts/module-map.json has a composition, all loaded and empty, requires and uses equal', () => {
    const got = loadRealTree();
    const ids = Object.keys(MAP.modules).sort();
    assert.deepStrictEqual(got.modules.map((/** @type {{ id: string }} */ m) => m.id), ids);
    for (const m of got.modules) {
        assert.strictEqual(m.state, 'loaded', `${m.id}: ${m.detail}`);
        assert.deepStrictEqual(m.requires, MAP.modules[m.id].requires, `${m.id}: requires differ from scripts/module-map.json`);
        assert.deepStrictEqual(m.uses, MAP.modules[m.id].uses, `${m.id}: uses differ from scripts/module-map.json`);
        const extra = got.keys[m.id].filter((/** @type {string} */ k) => !['id', 'requires', 'uses', ...PART_KEYS].includes(k));
        assert.deepStrictEqual(extra, [], `${m.id}: the composition holds more than its id, requires, uses and what its part files add`);
    }
    assert.deepStrictEqual(got.stores, []);
    assert.deepStrictEqual(got.migrations, []);
});
