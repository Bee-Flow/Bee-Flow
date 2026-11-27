/**
 * module-move: on a small temporary repository, the move itself (git mv, same tree paths,
 * one commit), the sha gate, the split of the eslint suppressions, the rewrite of repository
 * paths in other text files, and the refusals and the restore that keep a bad move out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ESLINT_CONFIG, main, moveModules, planMove, shaGate } from './module-move.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS_DIR = 'server/modules/roots';

const MAP = {
    packages: { server: { coreDir: 'server', moduleDir: 'server' } },
    modules: { alpha: { server: ['alpha/**', 'mixed/a.js'] } },
};

const FILES = {
    'scripts/module-map.json': JSON.stringify(MAP),
    'server/alpha/a.js': "const c = require('../core/c');\nmodule.exports = { c };\n",
    'server/alpha/a.test.js': "require('./a');\n",
    'server/alpha/b.js': 'module.exports = 2;\n',
    'server/core/c.js': 'module.exports = 3;\n',
    'server/mixed/a.js': 'module.exports = 4;\n',
    'server/mixed/core.js': 'module.exports = 5;\n',
    'server/eslint-suppressions.json': JSON.stringify({ 'alpha/a.js': { complexity: { count: 1 } }, 'core/c.js': { 'max-params': { count: 1 } } }, null, 2),
    'docs/guide.md': 'See server/alpha/a.js and server/core/c.js, or server/alpha/b for short.\n',
    'scripts/paths.json': JSON.stringify({ watch: ['server/alpha/', 'server/**'] }),
};

function sh(dir, ...args) {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function fixture(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-move-'));
    for (const [name, text] of Object.entries({ ...FILES, ...extra })) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    fs.mkdirSync(path.join(dir, ROOTS_DIR), { recursive: true });
    for (const f of ['rootSet.cjs', 'treeCheck.cjs']) fs.copyFileSync(path.join(REPO, ROOTS_DIR, f), path.join(dir, ROOTS_DIR, f));
    sh(dir, 'init', '--quiet');
    sh(dir, 'config', 'user.email', 'test@example.invalid');
    sh(dir, 'config', 'user.name', 'test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '--quiet', '-m', 'init');
    return dir;
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const clean = (dir) => sh(dir, 'status', '--porcelain').trim() === '';

test('a move: git mv on the same tree paths, suppressions split, paths rewritten, one commit, clean tree', () => {
    const dir = fixture();
    const report = moveModules({ repoRoot: dir, ids: ['alpha'], commands: [] });
    assert.equal(report.ok, true, JSON.stringify(report.gates, null, 2));
    assert.deepEqual(report.files, { alpha: 4 });
    for (const f of ['alpha/a.js', 'alpha/a.test.js', 'alpha/b.js', 'mixed/a.js']) {
        assert.ok(!exists(dir, `server/${f}`), `server/${f} left behind`);
        assert.equal(read(dir, `modules/alpha/server/${f}`), FILES[`server/${f}`]);
    }
    assert.ok(exists(dir, 'server/mixed/core.js'));
    assert.deepEqual(JSON.parse(read(dir, 'server/eslint-suppressions.json')), { 'core/c.js': { 'max-params': { count: 1 } } });
    assert.deepEqual(JSON.parse(read(dir, 'modules/alpha/server/eslint-suppressions.json')), { 'alpha/a.js': { complexity: { count: 1 } } });
    assert.equal(read(dir, 'modules/alpha/server/eslint.config.js'), ESLINT_CONFIG);
    assert.equal(read(dir, 'docs/guide.md'), 'See modules/alpha/server/alpha/a.js and server/core/c.js, or modules/alpha/server/alpha/b for short.\n');
    assert.deepEqual(JSON.parse(read(dir, 'scripts/paths.json')).watch, ['modules/alpha/server/alpha/', 'server/**'], 'a fully moved directory follows; the package stays');
    assert.ok(report.commit, 'committed');
    assert.match(sh(dir, 'log', '-1', '--format=%s'), /^Move module alpha to modules\/alpha\/server\n$/);
    assert.ok(clean(dir), sh(dir, 'status', '--porcelain'));
    for (const g of ['sha256', 'duplicateTreePaths', 'module-map --check', 'module-boundary']) assert.ok(report.gates.some((x) => x.name === g && x.ok), g);
});

test('the sha gate fails on a moved file whose bytes changed', () => {
    const dir = fixture();
    const report = moveModules({ repoRoot: dir, ids: ['alpha'], commands: [], noCommit: true });
    assert.equal(report.ok, true);
    assert.throws(() => planMove(dir, ['alpha'], { rehearse: true }), /no file of this module is left under server/);
    fs.appendFileSync(path.join(dir, 'modules/alpha/server/alpha/b.js'), '// changed\n');
    const moved = ['alpha/a.js', 'alpha/b.js'].map((t) => ({ treePath: t, id: 'alpha', from: `server/${t}`, to: `modules/alpha/server/${t}` }));
    const gate = shaGate(dir, moved);
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.problems, ['modules/alpha/server/alpha/b.js: content differs from HEAD:server/alpha/b.js']);
});

test('refuses an ignored destination and changes nothing', () => {
    const dir = fixture({ '.gitignore': 'modules/alpha/server/alpha/b.js\n' });
    assert.throws(() => moveModules({ repoRoot: dir, ids: ['alpha'], commands: [] }), /ignore these destinations.*alpha\/b\.js/);
    assert.ok(exists(dir, 'server/alpha/b.js'));
    assert.ok(!exists(dir, 'modules'));
    assert.ok(clean(dir));
});

test('refuses a manifest that names a directory the move splits, before touching anything', () => {
    const dir = fixture({ 'scripts/split.json': JSON.stringify({ dirs: ['server/mixed/'] }) });
    assert.throws(() => moveModules({ repoRoot: dir, ids: ['alpha'], commands: [] }), /splits across roots[\s\S]*scripts\/split\.json:1 server\/mixed\/ -> alpha, core/);
    assert.ok(exists(dir, 'server/mixed/a.js'));
    assert.ok(clean(dir));
});

test('a failed gate restores the tree and removes what the move created', () => {
    const dir = fixture();
    const report = moveModules({ repoRoot: dir, ids: ['alpha'], commands: [[process.execPath, '-e', 'process.exit(3)']] });
    assert.equal(report.ok, false);
    assert.equal(report.restored, true);
    assert.ok(report.gates.some((g) => !g.ok && g.detail === 'exit 3'));
    assert.ok(exists(dir, 'server/alpha/a.js'));
    assert.ok(!exists(dir, 'modules'), 'modules/ removed again');
    assert.equal(read(dir, 'docs/guide.md'), FILES['docs/guide.md']);
    assert.ok(clean(dir));
});

test('refuses a dirty work tree, an unknown id, and --all without --rehearse', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'server/core/c.js'), 'changed\n');
    assert.throws(() => moveModules({ repoRoot: dir, ids: ['alpha'], commands: [] }), /not clean/);
    sh(dir, 'checkout', '--', '.');
    assert.throws(() => moveModules({ repoRoot: dir, ids: ['beta'], commands: [] }), /unknown module id/);
    assert.equal(main(['--all']), 2);
});
