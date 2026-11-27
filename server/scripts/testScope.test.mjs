// @typecheck strict
/**
 * scripts/testScope.mjs: which files a scope takes (on a small fixture ownership map), the
 * --files and stale-exclusion rules, and NODE_OPTIONS as Node itself parses it.
 *
 * Run: node --test scripts/testScope.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileMap } from '../../scripts/module-map.mjs';
import {
    VALUE_FLAGS, collectTestFiles, exclusionTable, flagValueOf, parseHide, parseScope,
    pickFiles, resolverEnv, scopeFilter, staleExclusions, walkFilter, withPreload,
} from './testScope.mjs';

const RAW = {
    packages: { server: {} },
    modules: {
        alpha: { server: ['alpha/**', '!alpha/shared.*'] },
        beta: { server: ['beta/**'] },
    },
    core: { server: ['beta/keep/**'] },
};
const SOURCES = new Set(['alpha/a.js', 'alpha/shared.js', 'beta/b.js', 'beta/keep/k.js', 'core/c.js']);
const MAP = compileMap(RAW, (_pkg, p) => SOURCES.has(p));
/** @param {string} p @param {string | null} [moduleId] */
const ownerOf = (p, moduleId) => moduleId ?? MAP.ownerOf('server', p);
const TESTS = ['alpha/a.test.js', 'alpha/shared.test.js', 'beta/b.test.js', 'beta/keep/k.test.js', 'core/c.test.js', 'gamma/g.test.mjs'];
const IDS = ['alpha', 'beta', 'gamma'];

/** @param {import('./testScope.mjs').Scope} scope */
const pick = (scope) => TESTS.filter((p) => scopeFilter(scope, ownerOf)(p, p.startsWith('gamma/') ? 'gamma' : null));

test('a scope takes the files of its owners; colocated tests follow their source', () => {
    assert.deepStrictEqual(pick(parseScope(null, IDS)), TESTS);
    assert.deepStrictEqual(pick(parseScope('full', IDS)), TESTS);
    assert.deepStrictEqual(pick(parseScope('core', IDS)), ['alpha/shared.test.js', 'beta/keep/k.test.js', 'core/c.test.js']);
    assert.deepStrictEqual(pick(parseScope('alpha', IDS)), ['alpha/a.test.js']);
    // a file in a module root belongs to that module, whatever the globs say
    assert.deepStrictEqual(pick(parseScope('beta, gamma', IDS)), ['beta/b.test.js', 'gamma/g.test.mjs']);
});

test('an unknown id is an error; hiding takes all or ids', () => {
    assert.throws(() => parseScope('delta', IDS), /--scope: unknown module delta \(known: core, full, alpha/);
    assert.throws(() => parseScope(',', IDS), /needs core, full or module ids/);
    assert.strictEqual(parseHide('all', IDS), 'all');
    assert.strictEqual(parseHide('alpha,all', IDS), 'all');
    assert.strictEqual(parseHide(' alpha , beta ', IDS), 'alpha,beta');
    assert.throws(() => parseHide('core', IDS), /--hide-modules: unknown module core \(known: all, alpha/);
});

test('collection keeps test files only, by tree path, the first root winning', () => {
    const got = collectTestFiles([
        { treePath: 'z.test.js', abs: '/s/z.test.js', moduleId: null },
        { treePath: 'a.js', abs: '/s/a.js', moduleId: null },
        { treePath: 'm/x.test.mjs', abs: '/m/x/server/m/x.test.mjs', moduleId: 'x' },
        { treePath: 'z.test.js', abs: '/m/y/server/z.test.js', moduleId: 'y' },
    ]);
    assert.deepStrictEqual([...got.keys()], ['m/x.test.mjs', 'z.test.js']);
    assert.strictEqual(got.get('z.test.js')?.moduleId, null);
    assert.strictEqual(walkFilter('journeys'), false);
    assert.strictEqual(walkFilter('core/journeys'), true);
});

test('--files: exactly these, each a known, included test file of the scope', () => {
    const ctx = { known: new Set(TESTS), excluded: new Set(['core/c.test.js']), inScope: (/** @type {string} */ p) => !p.startsWith('gamma/') };
    assert.deepStrictEqual(pickFiles('beta/b.test.js, ./alpha/a.test.js,beta/b.test.js', ctx), ['alpha/a.test.js', 'beta/b.test.js']);
    assert.throws(() => pickFiles('', ctx), /at least one/);
    assert.throws(() => pickFiles('x.test.js,core/c.test.js,gamma/g.test.mjs', ctx),
        /x\.test\.js is not a test file of any root; core\/c\.test\.js is excluded .*; gamma\/g\.test\.mjs is outside the chosen --scope/);
});

test('a missing excluded file is stale only inside the scope', () => {
    const exclusions = [{ file: 'alpha/gone.test.js', bucket: 'failing', reason: 'r' }, { file: 'core/c.test.js', bucket: 'failing', reason: 'r' }];
    const exists = (/** @type {string} */ p) => p === 'core/c.test.js';
    const stale = (/** @type {string | null} */ s) => staleExclusions(exclusions, exists, (p) => scopeFilter(parseScope(s, IDS), ownerOf)(p)).map((e) => e.file);
    assert.deepStrictEqual(stale(null), ['alpha/gone.test.js']);
    assert.deepStrictEqual(stale('alpha'), ['alpha/gone.test.js']);
    assert.deepStrictEqual(stale('core'), []);
    assert.deepStrictEqual(stale('beta'), []);
});

test('flag values and the exclusion table', () => {
    assert.strictEqual(flagValueOf(['--scope', 'core'], '--scope'), 'core');
    assert.strictEqual(flagValueOf([], '--scope'), null);
    assert.throws(() => flagValueOf(['--scope', '--list'], '--scope'), /--scope needs a value/);
    for (const f of ['--scope', '--files', '--hide-modules']) assert.ok(VALUE_FLAGS.includes(f), f);
    const table = exclusionTable([{ file: 'a.test.js', bucket: 'failing', reason: 'why' }], ['needs-infra', 'failing']);
    assert.strictEqual(table, '\nfailing (1):\n  a.test.js  why\n\n1 file(s) excluded. Remove entries as they are fixed — this list should only get shorter.');
});

test('NODE_OPTIONS: appended once, and a path with a space or a quote survives Node\'s own parsing', () => {
    assert.strictEqual(withPreload(undefined, '/s/moduleRoots.cjs'), '--require=/s/moduleRoots.cjs');
    assert.strictEqual(withPreload(' --max-old-space-size=512 ', '/s/moduleRoots.cjs'), '--max-old-space-size=512 --require=/s/moduleRoots.cjs');
    const once = withPreload('--max-old-space-size=512', '/s/moduleRoots.cjs');
    assert.strictEqual(withPreload(once, '/s/moduleRoots.cjs'), once);
    const env = resolverEnv({ NODE_OPTIONS: '--no-warnings', X: '1' }, { preload: '/s/m.cjs', hide: 'all' });
    assert.deepStrictEqual(env, { NODE_OPTIONS: '--no-warnings --require=/s/m.cjs', X: '1', BEEFLOW_HIDE_MODULES: 'all' });
    assert.deepStrictEqual(resolverEnv({ X: '1' }, { preload: null, hide: null }), { X: '1' });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test scope "q" '));
    const preload = path.join(dir, 'pre load.cjs');
    fs.writeFileSync(preload, 'globalThis.__preloaded = true;\n');
    const clean = { ...process.env };
    delete clean.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(globalThis.__preloaded))'], {
        env: { ...clean, NODE_OPTIONS: withPreload('--no-warnings', preload) },
        encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'true');
    fs.rmSync(dir, { recursive: true, force: true });
});
