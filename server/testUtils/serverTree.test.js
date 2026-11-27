// @typecheck strict
'use strict';
/**
 * testUtils/serverTree.js, the walk the whole-tree guard tests and kits share.
 *
 * On the real tree (today one root) it must give exactly what a plain walk of server/
 * gives. In a temp tree with a second root (testUtils/moduleRootsFixture.testkit.js, the
 * module parent found as ../modules beside the core, or named by BEEFLOW_MODULE_ROOTS) it
 * must see the module's files by their tree paths, and fail when a root yields nothing.
 * The kits built on it (requireEdges, the PGlite template's source hash) are probed there
 * too, so a guard that goes through the kit cannot turn blind after a module moves.
 *
 * Run: cd server && node --test testUtils/serverTree.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { walkServerTree, treeJsFiles, treeFile, readTreeFile, requestPlaces } = require('./serverTree');
const { roots } = require('../moduleRoots.cjs');
const { buildFixture, runProbe, writeFiles } = require('./moduleRootsFixture.testkit.js');

const SERVER = path.resolve(__dirname, '..');

/**
 * The walk of server/ the guard tests made before they knew of module roots.
 * @param {string} dir
 * @param {string[]} [out]
 */
function plainWalk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (['node_modules', 'coverage', 'dist', '.git'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (dir === SERVER && ['eslint.config.js', 'eslint-suppressions.json'].includes(e.name)) continue;
        if (e.isDirectory()) plainWalk(p, out);
        else out.push(path.relative(SERVER, p).split(path.sep).join('/'));
    }
    return out;
}

test('on the real tree with one root: exactly the plain walk of server/', { skip: roots().length > 1 && 'module roots are present' }, () => {
    const files = walkServerTree();
    assert.deepEqual(files.map((f) => f.treePath), plainWalk(SERVER));
    assert.ok(files.every((f) => f.moduleId === null && f.abs === path.join(SERVER, f.treePath)));
    assert.ok(walkServerTree({ controlFiles: true }).some((f) => f.treePath === 'eslint.config.js'), 'controlFiles: true yields them');
});

test('on the real tree: lookups by tree path', () => {
    assert.equal(treeFile('index.js'), path.join(SERVER, 'index.js'));
    assert.equal(treeFile('no/such/file.js'), null);
    assert.equal(treeFile('core'), null, 'a directory is not a file');
    assert.equal(readTreeFile('index.js'), fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8'));
    assert.throws(() => readTreeFile('no/such/file.js'), /no root holds no\/such\/file\.js/);
    assert.deepEqual(requestPlaces('core/llm/llmClient.js', '../../db'), roots().map((r) => path.join(r.dir, 'db')));
    assert.deepEqual(requestPlaces('core/x.js', '../../agent-hub/src/a'), [path.resolve(SERVER, '..', 'agent-hub', 'src', 'a')]);
    const routes = walkServerTree({ under: 'routes' });
    assert.ok(routes.length > 0 && routes.every((f) => f.treePath.startsWith('routes/')));
    assert.ok(treeJsFiles().every((f) => f.treePath.endsWith('.js') && !f.treePath.endsWith('.test.js')));
});

describe('in a tree with a module root', () => {
    /** @type {ReturnType<typeof buildFixture>} */
    let fx;

    before(() => {
        fx = buildFixture({
            'core/eslint.config.js': '// control file\n',
            'core/feat/a.js': "require('../lib/moved');\nrequire('./b');\n",
            'core/feat/b.js': "module.exports = 'b';\n",
            'core/feat/a.test.js': '// test\n',
            'core/node_modules/@electric-sql/pglite/package.json': '{ "name": "@electric-sql/pglite", "version": "0.0.0", "main": "index.js" }\n',
            'core/node_modules/@electric-sql/pglite/index.js': 'exports.PGlite = class {};\n',
            'modules/m1/server/eslint.config.js': '// control file of the module root\n',
            'modules/m1/server/lib/moved.js': "require('../feat/b');\nmodule.exports = 'moved';\n",
            'modules/m1/server/routes/m1.js': "require('../lib/moved');\n",
            'modules/m1/server/node_modules/dep/index.js': '// never walked\n',
        });
        // The kits under test, at their tree paths in the fixture's core root.
        for (const name of ['serverTree.js', 'requireEdges.js', 'pgliteTemplate.js']) {
            fs.mkdirSync(path.join(fx.core, 'testUtils'), { recursive: true });
            fs.copyFileSync(path.join(__dirname, name), path.join(fx.core, 'testUtils', name));
        }
    });
    after(() => fx.remove());

    /** @param {string} name @param {string} code @param {Record<string, string>} [env] */
    const probe = (name, code, env) => {
        const r = runProbe(fx, name, code, env ? { env } : {});
        assert.equal(r.status, 0, r.stderr);
        return r.value;
    };

    test('the walk yields the module files by tree path, after the core, without control files or node_modules', () => {
        const got = probe('walk', `
            const t = require('../testUtils/serverTree.js');
            const strip = (f) => [f.treePath, f.moduleId];
            const notProbe = (rel) => !rel.startsWith('probe');
            out({
                all: t.walkServerTree({ filter: notProbe }).map(strip).filter(([p]) => /^(feat|lib|routes|eslint)/.test(p)),
                control: t.walkServerTree({ controlFiles: true }).filter((f) => f.treePath === 'eslint.config.js').map(strip),
                under: t.walkServerTree({ under: 'lib' }).map(strip),
                js: t.treeJsFiles().map(strip).filter(([p]) => /^(feat|lib|routes)/.test(p)),
                moved: t.readTreeFile('lib/moved.js').length > 0,
                places: t.requestPlaces('feat/a.js', '../lib/moved').map((p) => require('node:path').relative(${JSON.stringify(fx.dir)}, p)),
            });
        `);
        assert.deepEqual(got.all, [['feat/a.js', null], ['feat/a.test.js', null], ['feat/b.js', null], ['lib/moved.js', 'm1'], ['routes/m1.js', 'm1']]);
        assert.deepEqual(got.control, [['eslint.config.js', null], ['eslint.config.js', 'm1']]);
        assert.deepEqual(got.under, [['lib/moved.js', 'm1']]);
        assert.deepEqual(got.js, [['feat/a.js', null], ['feat/b.js', null], ['lib/moved.js', 'm1'], ['routes/m1.js', 'm1']]);
        assert.equal(got.moved, true);
        assert.deepEqual(got.places, ['core/lib/moved', 'modules/m1/server/lib/moved']);
    });

    test('a root that yields nothing fails the walk loudly, naming the root', () => {
        writeFiles(fx.dir, { 'modules/m2/server/node_modules/only/index.js': '// nothing of the tree\n' });
        try {
            const got = probe('blind', `
                const t = require('../testUtils/serverTree.js');
                let message = null;
                try { t.walkServerTree(); } catch (e) { message = e.message; }
                out({ message, under: t.walkServerTree({ under: 'feat' }).length, optOut: t.walkServerTree({ everyRoot: false }).length > 0 });
            `);
            assert.match(got.message, /no file found in m2 \(/);
            assert.ok(got.under > 0, 'a walk below a directory does not ask every root to have it');
            assert.equal(got.optOut, true);
        } finally {
            fs.rmSync(path.join(fx.dir, 'modules', 'm2'), { recursive: true, force: true });
        }
    });

    test('BEEFLOW_MODULE_ROOTS names the module parent; empty means the core root alone', () => {
        const code = "out(require('../testUtils/serverTree.js').walkServerTree().map((f) => f.moduleId).filter(Boolean).length);";
        assert.ok(probe('env-roots', code, { BEEFLOW_MODULE_ROOTS: path.join(fx.dir, 'modules') }) > 0);
        assert.equal(probe('env-none', code, { BEEFLOW_MODULE_ROOTS: '' }), 0);
    });

    test('the kits on top see the moved code: require edges, the template hash, a stub key', () => {
        const got = probe('kits', `
            const { requireEdges } = require('../testUtils/requireEdges.js');
            const { sourceHash } = require('../testUtils/pgliteTemplate.js');
            const path = require('node:path');
            out({
                edges: requireEdges({ targets: new Set(['lib/moved', 'feat/b']) }),
                hash: sourceHash(),
                stubKey: path.relative(${JSON.stringify(fx.dir)}, require.resolve(path.join(__dirname, '..', 'lib', 'moved'))),
            });
        `);
        assert.deepEqual(got.edges, [
            { from: 'feat/a.js', to: 'lib/moved' }, { from: 'feat/a.js', to: 'feat/b' },
            { from: 'lib/moved.js', to: 'feat/b' }, { from: 'routes/m1.js', to: 'lib/moved' },
        ]);
        assert.equal(got.stubKey, 'modules/m1/server/lib/moved.js', 'an absolute key under the core root resolves in the module root');
        // A schema edit in the module root must change the key of the cached ladder template.
        fs.appendFileSync(path.join(fx.moduleRoot('m1'), 'lib', 'moved.js'), '// CREATE TABLE x\n');
        const hashAfter = probe('kits-after', "out(require('../testUtils/pgliteTemplate.js').sourceHash());");
        assert.notEqual(hashAfter, got.hash);
        const coreOnly = probe('kits-core', "out(require('../testUtils/pgliteTemplate.js').sourceHash());", { BEEFLOW_MODULE_ROOTS: '' });
        assert.notEqual(coreOnly, hashAfter, 'the module root is part of the hash');
    });
});
