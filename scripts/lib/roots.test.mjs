/**
 * scripts/lib/roots.mjs against a fixture checkout: a core and two modules for both
 * packages, the skip list, lookups across roots, and "no modules = plain walk".
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoots, rootsOf, walkTree, repoRoot, SKIP_DIRS } from './roots.mjs';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** @param {string} prefix */
function tempDir(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(d);
    return d;
}

/** @param {string} root @param {string[]} files */
function writeFiles(root, files) {
    for (const rel of files) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `// ${rel}\n`);
    }
}

function fixture(withModules = true) {
    const dir = tempDir('roots-');
    writeFiles(dir, [
        'server/index.js', 'server/core/llm/llmClient.js', 'server/eslint.config.js',
        'server/node_modules/pkg/index.js', 'server/coverage/lcov.info', 'server/core/dist/x.js',
        'agent-hub/package.json', 'agent-hub/src/App.tsx', 'agent-hub/dist/index.html',
    ]);
    if (withModules) {
        writeFiles(dir, [
            'modules/zeta/server/zeta/run.js', 'modules/zeta/server/eslint-suppressions.json',
            'modules/alpha/server/alpha/a.js', 'modules/alpha/server/core/llm/alphaHelper.js',
            'modules/alpha/frontend/src/components/alpha/A.tsx',
            'modules/zeta/frontend/src/pages/Z.tsx', 'modules/zeta/frontend/node_modules/x/y.js',
            'modules/docsOnly/README.md',
        ]);
    }
    return dir;
}

/** Run fn with BEEFLOW_MODULE_ROOTS unset, so the default parent (<repo>/modules) applies. */
function withDefaultParents(fn) {
    const saved = process.env.BEEFLOW_MODULE_ROOTS;
    delete process.env.BEEFLOW_MODULE_ROOTS;
    try {
        return fn();
    } finally {
        if (saved !== undefined) process.env.BEEFLOW_MODULE_ROOTS = saved;
    }
}

test('rootsOf: core first, then the modules by id; a module without that package has no root', () => withDefaultParents(() => {
    const dir = fixture();
    const r = createRoots({ repoRoot: dir });
    assert.deepStrictEqual(r.rootsOf('server'), [
        { id: null, dir: path.join(dir, 'server') },
        { id: 'alpha', dir: path.join(dir, 'modules/alpha/server') },
        { id: 'zeta', dir: path.join(dir, 'modules/zeta/server') },
    ]);
    assert.deepStrictEqual(r.rootsOf('agent-hub').map((x) => [x.id, path.relative(dir, x.dir)]), [
        [null, 'agent-hub'], ['alpha', path.join('modules', 'alpha', 'frontend')], ['zeta', path.join('modules', 'zeta', 'frontend')],
    ]);
    assert.throws(() => r.rootsOf('mobile'), /unknown package "mobile"/);
}));

test('walkTree: tree paths per root in order, skip list and control files left out', () => withDefaultParents(() => {
    const r = createRoots({ repoRoot: fixture() });
    assert.deepStrictEqual([...r.walkTree('server')].map((f) => [f.moduleId, f.treePath]), [
        [null, 'core/llm/llmClient.js'], [null, 'index.js'],
        ['alpha', 'alpha/a.js'], ['alpha', 'core/llm/alphaHelper.js'],
        ['zeta', 'zeta/run.js'],
    ]);
    assert.deepStrictEqual([...r.walkTree('agent-hub')].map((f) => [f.moduleId, f.treePath]), [
        [null, 'package.json'], [null, 'src/App.tsx'],
        ['alpha', 'src/components/alpha/A.tsx'], ['zeta', 'src/pages/Z.tsx'],
    ]);
    const withControl = [...r.walkTree('server', { controlFiles: true })].map((f) => f.treePath);
    assert.ok(withControl.includes('eslint.config.js') && withControl.includes('eslint-suppressions.json'));
    assert.ok(!withControl.some((p) => SKIP_DIRS.some((d) => p.split('/').includes(d))), 'SKIP_DIRS stay out with controlFiles');
}));

test('walkTree: abs points at the file, filter prunes early, under limits to a subtree', () => withDefaultParents(() => {
    const dir = fixture();
    const r = createRoots({ repoRoot: dir });
    for (const f of r.walkTree('server')) assert.strictEqual(fs.readFileSync(f.abs, 'utf8'), `// ${path.relative(dir, f.abs).split(path.sep).join('/')}\n`);
    const seen = [];
    const files = [...r.walkTree('server', { filter: (p) => (seen.push(p), p !== 'core') })].map((f) => f.treePath);
    assert.deepStrictEqual(files, ['index.js', 'alpha/a.js', 'zeta/run.js']);
    assert.ok(!seen.includes('core/llm'), 'a pruned directory is not entered');
    assert.deepStrictEqual([...r.walkTree('server', { under: 'core' })].map((f) => [f.moduleId, f.treePath]), [
        [null, 'core/llm/llmClient.js'], ['alpha', 'core/llm/alphaHelper.js'],
    ]);
}));

test('resolveTreePath finds the root that has the file; locate gives it back', () => withDefaultParents(() => {
    const dir = fixture();
    const r = createRoots({ repoRoot: dir });
    assert.strictEqual(r.resolveTreePath('server', 'core/llm/llmClient.js'), path.join(dir, 'server/core/llm/llmClient.js'));
    assert.strictEqual(r.resolveTreePath('server', 'core/llm/alphaHelper.js'), path.join(dir, 'modules/alpha/server/core/llm/alphaHelper.js'));
    assert.strictEqual(r.resolveTreePath('agent-hub', 'src/pages/Z.tsx'), path.join(dir, 'modules/zeta/frontend/src/pages/Z.tsx'));
    assert.strictEqual(r.resolveTreePath('server', 'nope.js'), null);
    assert.deepStrictEqual(r.locate(path.join(dir, 'modules/zeta/server/zeta/run.js')), { pkg: 'server', treePath: 'zeta/run.js', moduleId: 'zeta' });
    assert.deepStrictEqual(r.locate(path.join(dir, 'agent-hub/src/App.tsx')), { pkg: 'agent-hub', treePath: 'src/App.tsx', moduleId: null });
    assert.deepStrictEqual(r.locate(path.join(dir, 'modules/alpha/frontend/src/components/alpha/A.tsx')), { pkg: 'agent-hub', treePath: 'src/components/alpha/A.tsx', moduleId: 'alpha' });
    assert.strictEqual(r.locate(path.join(dir, 'modules/docsOnly/README.md')), null);
    assert.strictEqual(r.toRepoPath(path.join(dir, 'server', 'index.js')), 'server/index.js');
    assert.strictEqual(r.fromRepoPath('server/index.js'), path.join(dir, 'server', 'index.js'));
}));

test('BEEFLOW_MODULE_ROOTS names the parents (as in rootSet.cjs); the empty string means no modules', () => {
    const dir = fixture();
    const elsewhere = tempDir('roots-parent-');
    writeFiles(elsewhere, ['beta/server/beta/b.js']);
    const saved = process.env.BEEFLOW_MODULE_ROOTS;
    try {
        process.env.BEEFLOW_MODULE_ROOTS = [elsewhere, path.join(dir, 'modules')].join(path.delimiter);
        assert.deepStrictEqual(createRoots({ repoRoot: dir }).rootsOf('server').map((x) => x.id), [null, 'alpha', 'beta', 'zeta']);
        process.env.BEEFLOW_MODULE_ROOTS = '';
        assert.deepStrictEqual(createRoots({ repoRoot: dir }).rootsOf('server').map((x) => x.id), [null]);
    } finally {
        if (saved === undefined) delete process.env.BEEFLOW_MODULE_ROOTS;
        else process.env.BEEFLOW_MODULE_ROOTS = saved;
    }
});

test('a module parent inside the core root is walked as the module, not twice', () => {
    const dir = fixture(false);
    writeFiles(dir, ['server/data/mods/gamma/server/gamma/g.js']);
    const saved = process.env.BEEFLOW_MODULE_ROOTS;
    try {
        process.env.BEEFLOW_MODULE_ROOTS = path.join(dir, 'server/data/mods');
        const r = createRoots({ repoRoot: dir });
        assert.deepStrictEqual([...r.walkTree('server')].map((f) => [f.moduleId, f.treePath]), [
            [null, 'core/llm/llmClient.js'], [null, 'index.js'], ['gamma', 'gamma/g.js'],
        ]);
        assert.deepStrictEqual(r.locate(path.join(dir, 'server/data/mods/gamma/server/gamma/g.js')), { pkg: 'server', treePath: 'gamma/g.js', moduleId: 'gamma' });
    } finally {
        if (saved === undefined) delete process.env.BEEFLOW_MODULE_ROOTS;
        else process.env.BEEFLOW_MODULE_ROOTS = saved;
    }
});

/** A plain recursive walk, the way the repository's scripts do it today. */
function plainWalk(dir, rel = '', out = []) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && SKIP_DIRS.includes(e.name)) continue;
        if (e.isDirectory()) plainWalk(dir, child, out);
        else out.push(child);
    }
    return out;
}

test('no modules: every function is a plain walk of the core directory', () => withDefaultParents(() => {
    const dir = fixture(false);
    const r = createRoots({ repoRoot: dir });
    assert.deepStrictEqual(r.rootsOf('server'), [{ id: null, dir: path.join(dir, 'server') }]);
    assert.deepStrictEqual([...r.walkTree('server', { controlFiles: true })].map((f) => f.treePath).sort(), plainWalk(path.join(dir, 'server')).sort());
    assert.deepStrictEqual([...r.walkTree('agent-hub')].map((f) => f.treePath).sort(), plainWalk(path.join(dir, 'agent-hub')).sort());
}));

test('this repository: with no module parent, the named walk is a plain walk of agent-hub/src', () => {
    const saved = process.env.BEEFLOW_MODULE_ROOTS;
    process.env.BEEFLOW_MODULE_ROOTS = '';
    try {
        assert.deepStrictEqual(rootsOf('server'), [{ id: null, dir: path.join(repoRoot, 'server') }]);
        const expected = plainWalk(path.join(repoRoot, 'agent-hub', 'src')).map((p) => `src/${p}`).sort();
        assert.deepStrictEqual([...walkTree('agent-hub', { under: 'src' })].map((f) => f.treePath).sort(), expected);
    } finally {
        if (saved === undefined) delete process.env.BEEFLOW_MODULE_ROOTS;
        else process.env.BEEFLOW_MODULE_ROOTS = saved;
    }
});
