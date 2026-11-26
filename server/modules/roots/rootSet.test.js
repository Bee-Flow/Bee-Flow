/**
 * modules/roots/rootSet.cjs and the helpers of server/moduleRoots.cjs: where the roots come
 * from (BEEFLOW_MODULE_ROOTS), core mode (BEEFLOW_HIDE_MODULES) and treePath, listTreeDir,
 * dataPath, repoPath, toTreePath, rootOf. Each test runs one probe in a child process of a
 * fixture built once (testUtils/moduleRootsFixture.testkit.js).
 *
 * The fixture's scripts/module-map.mjs is a stand-in that proves the contract the core-mode
 * lookup relies on: loadModuleMap().ownerOf('server', treePath) names the owner of a file
 * that still sits in the core root. Here legacy1/** belongs to m1; the real map has its own
 * tests (scripts/module-map.test.mjs).
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { buildFixture, runProbe, writeFiles } = require('../../testUtils/moduleRootsFixture.testkit');

const M1 = 'modules/m1/server';
const M2 = 'modules/m2/server';

const FILES = {
    'scripts/module-map.mjs': [
        'export function loadModuleMap() {',
        '    return { ownerOf: (pkg, treePath) => (pkg === "server" && treePath.startsWith("legacy1/") ? "m1" : null) };',
        '}',
    ].join('\n'),
    'core/lib/shared.js': 'module.exports = "core-shared";',
    'core/legacy1/x.js': 'module.exports = "legacy-in-core";',
    [`${M1}/feat/a.js`]: 'module.exports = "m1-a";',
    [`${M1}/feat/e.mjs`]: 'export default "m1-e";',
    [`${M1}/lib/own.js`]: 'module.exports = "m1-own";',
    [`${M2}/other/b.js`]: 'module.exports = "m2-b";',
    [`${M2}/lib/zz.js`]: 'module.exports = "m2-zz";',
};

/** @type {ReturnType<typeof buildFixture>} */
let fx;
before(() => { fx = buildFixture(FILES); });
after(() => fx.remove());

/** Run a probe and return what it reported; fail with its stderr when it crashed. */
function value(name, code, opts) {
    const r = runProbe(fx, name, code, opts);
    assert.strictEqual(r.status, 0, `probe ${name} failed:\n${r.stderr}`);
    return r.value;
}

/** Probe code that tries each request and reports what it got, or the error code and first line. */
function attempts(requests) {
    return [
        `const requests = ${JSON.stringify(requests)};`,
        'const tryOne = (r) => { try { return require(r); } catch (err) { return { code: err.code, message: err.message.split("\\n")[0] }; } };',
        'out(requests.map(tryOne));',
    ].join('\n');
}

const absent = (request, owner) => ({
    code: 'MODULE_NOT_FOUND',
    message: `Cannot find module '${request}': module "${owner}" is not present`,
});

describe('BEEFLOW_MODULE_ROOTS', () => {
    test('unset: the module roots are ../modules/<id>/server beside the core, core first', () => {
        const got = value('defaultRoots', 'out(require(ROOTS_LIB).roots());');
        assert.deepStrictEqual(got, [
            { id: null, dir: fx.core },
            { id: 'm1', dir: fx.moduleRoot('m1') },
            { id: 'm2', dir: fx.moduleRoot('m2') },
        ]);
    });

    test('an explicit list replaces the default place; the first parent that has an id wins', () => {
        const extA = path.join(fx.dir, 'extA');
        const extB = path.join(fx.dir, 'extB');
        writeFiles(fx.dir, {
            'extA/m9/server/n.js': 'module.exports = "a-m9";',
            'extB/m9/server/n.js': 'module.exports = "b-m9";',
            'extB/m8/server/n8.js': 'module.exports = "b-m8";',
        });
        const got = value('explicitRoots', [
            'const roots = require(ROOTS_LIB).roots().map((r) => r.id);',
            'out({ roots, n: require("../n"), n8: require("../n8") });',
        ].join('\n'), { env: { BEEFLOW_MODULE_ROOTS: [extA, extB].join(path.delimiter) } });
        assert.deepStrictEqual(got, { roots: [null, 'm8', 'm9'], n: 'a-m9', n8: 'b-m8' });
    });

    test('the empty string means no modules: module files are absent and nothing is patched', () => {
        const got = value('noModules', [
            'const Module = require("node:module");',
            'const original = Module._resolveFilename;',
            'const roots = require(ROOTS_LIB).roots();',
            'let a; try { a = require("../feat/a"); } catch (err) { a = err.code; }',
            'out({ roots: roots.length, unpatched: original === Module._resolveFilename, a });',
        ].join('\n'), { preload: false, env: { BEEFLOW_MODULE_ROOTS: '' } });
        assert.deepStrictEqual(got, { roots: 1, unpatched: true, a: 'MODULE_NOT_FOUND' });
    });
});

describe('core mode (BEEFLOW_HIDE_MODULES)', () => {
    test('=m1 hides the m1 root and leaves m2 and the core', () => {
        const got = value('hideM1', attempts(['../feat/a', '../other/b', '../lib/shared']),
            { env: { BEEFLOW_HIDE_MODULES: 'm1' } });
        assert.deepStrictEqual(got, [absent('../feat/a', 'm1'), 'm2-b', 'core-shared']);
    });

    test('=m1 also hides a file m1 owns that still sits in the core root (owner from scripts/module-map.mjs)', () => {
        const got = value('hideM1Legacy', attempts(['../legacy1/x']), { env: { BEEFLOW_HIDE_MODULES: 'm1' } });
        assert.deepStrictEqual(got, [absent('../legacy1/x', 'm1')]);
    });

    test('=m1 hides that core-root file even when no module root exists at all', () => {
        const got = value('hideNoRoots', attempts(['../legacy1/x', '../lib/shared']),
            { env: { BEEFLOW_HIDE_MODULES: 'm1', BEEFLOW_MODULE_ROOTS: '' } });
        assert.deepStrictEqual(got, [absent('../legacy1/x', 'm1'), 'core-shared']);
    });

    test('=all hides every module and leaves the core', () => {
        const got = value('hideAll', attempts(['../feat/a', '../other/b', '../legacy1/x', '../lib/shared']),
            { env: { BEEFLOW_HIDE_MODULES: 'all' } });
        assert.deepStrictEqual(got, [absent('../feat/a', 'm1'), absent('../other/b', 'm2'), absent('../legacy1/x', 'm1'), 'core-shared']);
    });

    test('an import of a hidden file throws ERR_MODULE_NOT_FOUND naming the module', () => {
        const got = value('hideImport', [
            'import("../feat/e.mjs").then(() => out("loaded"), (err) => out({ code: err.code, message: err.message.split("\\n")[0] }));',
        ].join('\n'), { env: { BEEFLOW_HIDE_MODULES: 'm1' } });
        assert.deepStrictEqual(got, { code: 'ERR_MODULE_NOT_FOUND', message: `Cannot find module '../feat/e.mjs': module "m1" is not present` });
    });

    test('treePath and listTreeDir skip hidden files', () => {
        const got = value('hideHelpers', [
            'const fs = require("node:fs");',
            'const roots = require(ROOTS_LIB);',
            'out({',
            '    a: fs.existsSync(roots.treePath("feat/a.js")),',
            '    b: fs.existsSync(roots.treePath("other/b.js")),',
            '    lib: roots.listTreeDir("lib").map((e) => e.name),',
            '    legacy: roots.listTreeDir("legacy1").map((e) => e.name),',
            '});',
        ].join('\n'), { env: { BEEFLOW_HIDE_MODULES: 'm1' } });
        assert.deepStrictEqual(got, { a: false, b: true, lib: ['shared.js', 'zz.js'], legacy: [] });
    });
});

describe('the path helpers', () => {
    test('treePath finds a file in the root that holds it, and falls back to the core path', () => {
        const got = value('treePath', [
            'const roots = require(ROOTS_LIB);',
            'out([roots.treePath("other", "b.js"), roots.treePath("lib/shared.js"), roots.treePath("nowhere/x.js")]);',
        ].join('\n'));
        assert.deepStrictEqual(got, [
            path.join(fx.moduleRoot('m2'), 'other', 'b.js'),
            path.join(fx.core, 'lib', 'shared.js'),
            path.join(fx.core, 'nowhere', 'x.js'),
        ]);
    });

    test('listTreeDir joins a directory over every root, sorted by name, with the owning module', () => {
        const got = value('listTreeDir', 'out(require(ROOTS_LIB).listTreeDir("lib"));');
        assert.deepStrictEqual(got, [
            { name: 'own.js', abs: path.join(fx.moduleRoot('m1'), 'lib', 'own.js'), moduleId: 'm1' },
            { name: 'shared.js', abs: path.join(fx.core, 'lib', 'shared.js'), moduleId: null },
            { name: 'zz.js', abs: path.join(fx.moduleRoot('m2'), 'lib', 'zz.js'), moduleId: 'm2' },
        ]);
    });

    test('dataPath stays beside the core and repoPath is beside the core root', () => {
        const got = value('dataRepo', [
            'const roots = require(ROOTS_LIB);',
            'out({ data: roots.dataPath("uploads", "x"), repo: roots.repoPath("agent-hub"), core: roots.coreRoot });',
        ].join('\n'));
        assert.deepStrictEqual(got, {
            data: path.join(fx.core, 'data', 'uploads', 'x'),
            repo: path.join(fx.dir, 'agent-hub'),
            core: fx.core,
        });
    });

    test('toTreePath and rootOf name a file by its root; outside every root they give null', () => {
        const files = [path.join(fx.moduleRoot('m1'), 'feat', 'a.js'), path.join(fx.core, 'lib', 'shared.js'), path.join(fx.dir, 'x.js')];
        const got = value('toTreePath', [
            'const roots = require(ROOTS_LIB);',
            `out(${JSON.stringify(files)}.map((f) => ({ tree: roots.toTreePath(f), root: roots.rootOf(f) && roots.rootOf(f).id })));`,
        ].join('\n'));
        assert.deepStrictEqual(got, [{ tree: 'feat/a.js', root: 'm1' }, { tree: 'lib/shared.js', root: null }, { tree: null, root: null }]);
    });
});
