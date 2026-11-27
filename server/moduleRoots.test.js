/**
 * server/moduleRoots.cjs: the roots of the tree resolve as one tree.
 *
 * A fixture with a core root and two module roots (m1, m2) is built once; every test runs
 * one probe in a child process (testUtils/moduleRootsFixture.testkit.js). The probes sit in
 * <core>/probe/, so `../x` in a probe is the tree path `x`. Core mode, the environment and
 * the helpers are in modules/roots/rootSet.test.js, the duplicate check in treeCheck.test.js.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { buildFixture, runProbe } = require('./testUtils/moduleRootsFixture.testkit');

const M1 = 'modules/m1/server';
const M2 = 'modules/m2/server';

const FILES = {
    'core/node_modules/pkg/package.json': '{ "name": "pkg", "main": "index.js" }',
    'core/node_modules/pkg/index.js': 'module.exports = { name: "core-pkg" };',
    'core/lib/shared.js': 'module.exports = { who: "core/lib/shared" };',
    'core/lib/fromCore.js': 'module.exports = require("../feat/a");',
    'core/lib/esmCore.mts': 'export const esmCore: string = "core-esm";',
    [`${M1}/node_modules/pkg/index.js`]: 'module.exports = { name: "m1-pkg" };',
    [`${M1}/node_modules/onlyM1/index.js`]: 'module.exports = { name: "m1-only" };',
    [`${M1}/feat/a.js`]: [
        'module.exports = {',
        '    shared: require("../lib/shared"),',
        '    other: require("../other/b"),',
        '    own: require("../lib/own"),',
        '};',
    ].join('\n'),
    [`${M1}/feat/pkgs.js`]: 'module.exports = { pkg: require("pkg").name, onlyM1: require("onlyM1").name };',
    [`${M1}/lib/own.js`]: 'module.exports = "m1-own";',
    // beside the core root, outside the tree (as agent-hub/ is beside server/)
    'sibling/outside.js': 'module.exports = "beside-core";',
    [`${M1}/feat/leaves.js`]: 'module.exports = require("../../sibling/outside");',
    [`${M1}/feat/e.mts`]: [
        'import { esmCore } from "../lib/esmCore.mts";',
        'import { createRequire } from "node:module";',
        'import pkg from "pkg";',
        'const nodeRequire = createRequire(import.meta.url);',
        'export const out = { esmCore, who: nodeRequire("../lib/shared").who, pkg: pkg.name };',
    ].join('\n'),
    [`${M1}/feat/worker.js`]: [
        'const { parentPort } = require("node:worker_threads");',
        'parentPort.postMessage(require("../lib/shared").who);',
    ].join('\n'),
    [`${M1}/feat/child.js`]: 'process.send(require("../other/b"));',
    [`${M2}/other/b.js`]: 'module.exports = "m2-b";',
    [`${M2}/other/fromM2.js`]: 'module.exports = require("../lib/own");',
    [`${M2}/thing/index.js`]: 'module.exports = "m2-thing";',
    [`${M2}/data/conf.json`]: '{ "from": "m2-json" }',
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

describe('require across roots', () => {
    test('core to module: a core file requires a file that lives in m1', () => {
        assert.deepStrictEqual(value('coreToModule', 'out(require("../lib/fromCore").own);'), 'm1-own');
    });

    test('module to core, module to module and within the module', () => {
        const a = value('moduleTo', 'out(require("../feat/a"));');
        assert.deepStrictEqual(a, { shared: { who: 'core/lib/shared' }, other: 'm2-b', own: 'm1-own' });
        assert.strictEqual(value('m2ToM1', 'out(require("../other/fromM2"));'), 'm1-own');
    });

    test('one instance: a file reached through another root is the same object as a direct require', () => {
        const same = value('instance', [
            'const viaModule = require("../feat/a").shared;',
            'out(viaModule === require("../lib/shared"));',
        ].join('\n'));
        assert.strictEqual(same, true);
    });

    test('require.resolve names the file in the root that holds it', () => {
        assert.strictEqual(value('resolve', 'out(require.resolve("../other/b"));'),
            path.join(fx.moduleRoot('m2'), 'other', 'b.js'));
    });

    test('createRequire from a core file follows a module file', () => {
        const got = value('createRequire', [
            'const { createRequire } = require("node:module");',
            'out(createRequire(__filename)("../other/b"));',
        ].join('\n'));
        assert.strictEqual(got, 'm2-b');
    });

    test('an absolute request under the core root lands on the module that holds the tree path', () => {
        const got = value('absolute', 'out(require(require("node:path").join(__dirname, "..", "other", "b.js")));');
        assert.strictEqual(got, 'm2-b');
    });

    test('a directory request finds index.js in another root', () => {
        assert.strictEqual(value('directory', 'out(require("../thing"));'), 'm2-thing');
    });

    test('a JSON file in another root', () => {
        assert.deepStrictEqual(value('json', 'out(require("../data/conf.json"));'), { from: 'm2-json' });
    });
});

describe('a relative request that leaves the tree', () => {
    test('from a module root it means the place beside the core root, as before the file moved', () => {
        assert.strictEqual(value('leavesTree', 'out(require("../feat/leaves"));'), 'beside-core');
    });
});

describe('ES modules and .mts across roots', () => {
    test('require() of a .mts module file whose static import lives in the core', () => {
        const got = value('requireMts', 'out({ ...require("../feat/e.mts").out });');
        assert.deepStrictEqual(got, { esmCore: 'core-esm', who: 'core/lib/shared', pkg: 'core-pkg' });
    });

    test('a static import of a module file from an ES module in the core', () => {
        const got = value('staticImport', 'import { out as e } from "../feat/e.mts";\nout(e.esmCore);', { esm: true });
        assert.strictEqual(got, 'core-esm');
    });

    test('a dynamic import() of a module file, relative and as a file: URL', () => {
        const got = value('dynamicImport', [
            'const { pathToFileURL } = require("node:url");',
            '(async () => {',
            '    const rel = await import("../feat/e.mts");',
            '    const url = await import(pathToFileURL(require("node:path").join(__dirname, "..", "other", "b.js")).href);',
            '    out([rel.out.who, url.default]);',
            '})();',
        ].join('\n'));
        assert.deepStrictEqual(got, ['core/lib/shared', 'm2-b']);
    });
});

describe('packages asked for from a module root', () => {
    test('a package name resolves from the core root first, the module root only for what the core lacks', () => {
        assert.deepStrictEqual(value('packages', 'out(require("../feat/pkgs"));'), { pkg: 'core-pkg', onlyM1: 'm1-only' });
    });

    test('a module root with no node_modules above it still gets the core packages (require and import)', () => {
        const ext = path.join(fx.dir, 'elsewhere');
        require('./testUtils/moduleRootsFixture.testkit').writeFiles(ext, {
            'm3/server/use/pkg.js': 'module.exports = require("pkg").name;',
            'm3/server/use/pkg.mjs': 'import pkg from "pkg"; export default pkg.name;',
        });
        const got = value('packagesElsewhere', [
            '(async () => out([require("../use/pkg"), (await import("../use/pkg.mjs")).default]))();',
        ].join('\n'), { env: { BEEFLOW_MODULE_ROOTS: ext } });
        assert.deepStrictEqual(got, ['core-pkg', 'core-pkg']);
    });
});

describe('threads and child processes', () => {
    /** A probe that starts m1's worker file (by its absolute path) with execArgv: []. */
    const workerProbe = () => [
        'const { Worker } = require("node:worker_threads");',
        `const w = new Worker(${JSON.stringify(path.join(fx.moduleRoot('m1'), 'feat', 'worker.js'))}, { execArgv: [] });`,
        'w.once("message", (m) => out({ ok: m }));',
        'w.once("error", (err) => out({ error: err.code }));',
    ].join('\n');

    test('a worker thread started with execArgv: [] gets the resolver through NODE_OPTIONS', () => {
        assert.deepStrictEqual(value('workerNodeOptions', workerProbe(), { viaNodeOptions: true }),
            { ok: 'core/lib/shared' });
    });

    test('without NODE_OPTIONS (a --require on the command line) such a worker does NOT get it', () => {
        assert.deepStrictEqual(value('workerCommandLine', workerProbe()), { error: 'MODULE_NOT_FOUND' });
    });

    test('a forked child process gets the resolver through NODE_OPTIONS', () => {
        const got = value('fork', [
            'const child = require("node:child_process").fork(',
            `    ${JSON.stringify(path.join(fx.moduleRoot('m1'), 'feat', 'child.js'))});`,
            'child.once("message", (m) => { out(m); child.kill(); });',
        ].join('\n'), { viaNodeOptions: true });
        assert.strictEqual(got, 'm2-b');
    });
});

describe('a request that exists nowhere', () => {
    test('require throws MODULE_NOT_FOUND naming the request as written', () => {
        const got = value('missingRequire', [
            'try { require("../nowhere/x"); out("loaded"); }',
            'catch (err) { out({ code: err.code, message: err.message.split("\\n")[0] }); }',
        ].join('\n'));
        assert.deepStrictEqual(got, { code: 'MODULE_NOT_FOUND', message: "Cannot find module '../nowhere/x'" });
    });

    test('import throws ERR_MODULE_NOT_FOUND naming the request in the asking root, not in another root', () => {
        const got = value('missingImport', [
            'import("../nowhere/x.mjs").then(() => out("loaded"),',
            '    (err) => out({ code: err.code, message: err.message }));',
        ].join('\n'));
        assert.strictEqual(got.code, 'ERR_MODULE_NOT_FOUND');
        assert.ok(got.message.includes(path.join(fx.core, 'nowhere', 'x.mjs')), got.message);
        assert.ok(!got.message.includes(path.join('modules', 'm1')), got.message);
    });
});

describe('installing the hooks', () => {
    test('requiring the resolver again, even after clearing the require cache, does not wrap twice', () => {
        const got = value('twice', [
            'const Module = require("node:module");',
            'const first = Module._resolveFilename;',
            'require(ROOTS_LIB);',
            'for (const key of Object.keys(require.cache)) if (key.endsWith(".cjs")) delete require.cache[key];',
            'require(ROOTS_LIB);',
            'out({ same: first === Module._resolveFilename, works: require("../other/b") });',
        ].join('\n'));
        assert.deepStrictEqual(got, { same: true, works: 'm2-b' });
    });

    test('with module roots present, loading the resolver patches require resolution', () => {
        const got = value('patched', [
            'const Module = require("node:module");',
            'const before = Module._resolveFilename;',
            'require(ROOTS_LIB);',
            'out(before !== Module._resolveFilename);',
        ].join('\n'), { preload: false });
        assert.strictEqual(got, true);
    });
});
