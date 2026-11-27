/**
 * utils/treeDir.js: directory reads over every root of the tree.
 *
 * Today the tree has one root, so the multi-root cases run in a fixture with a core root and two
 * module roots (testUtils/moduleRootsFixture.testkit.js), with treeDir.js copied into its core;
 * the one-root cases run against the real server/ and must give what fs gave before.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildFixture, runProbe } = require('../testUtils/moduleRootsFixture.testkit');
const { dirEntries, walkTreeFiles, treeFileAt } = require('./treeDir');

const SERVER = path.resolve(__dirname, '..');
const M1 = 'modules/m1/server';
const M2 = 'modules/m2/server';

describe('with one root (today)', () => {
    test('dirEntries of a tree directory is the sorted plain read', () => {
        const dir = path.join(SERVER, 'compliance', 'connectors');
        const want = fs.readdirSync(dir).sort().map((name) => ({ name, abs: path.join(dir, name) }));
        assert.deepStrictEqual(dirEntries(dir), want);
    });

    test('walkTreeFiles is the recursive read, keyed by the path below the directory', () => {
        const dir = path.join(SERVER, 'appStudio', 'componentSpecs', 'keys');
        const got = [...walkTreeFiles(dir)];
        assert.ok(got.length > 0);
        for (const { rel, abs } of got) assert.strictEqual(abs, path.join(dir, ...rel.split('/')));
    });

    test('a missing directory has no entries', () => {
        assert.deepStrictEqual(dirEntries(path.join(SERVER, 'no', 'such', 'dir')), []);
    });

    test('treeFileAt names the same file', () => {
        const file = path.join(SERVER, 'auth', 'loginPaths.js');
        assert.strictEqual(treeFileAt(file), file);
    });

    test('outside the tree: a plain sorted read, and the path as given', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-dir-'));
        try {
            for (const name of ['b.js', 'a.js', 'c']) fs.writeFileSync(path.join(dir, name), '');
            assert.deepStrictEqual(dirEntries(dir).map((e) => e.name), ['a.js', 'b.js', 'c']);
            assert.strictEqual(treeFileAt(path.join(dir, 'x.js')), path.join(dir, 'x.js'));
            assert.deepStrictEqual(dirEntries(path.join(dir, 'gone')), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('with several roots', () => {
    /** @type {ReturnType<typeof buildFixture>} */
    let fx;
    before(() => {
        fx = buildFixture({
            'core/reg/b.js': '',
            'core/reg/sub/deep.js': '',
            [`${M1}/reg/a.js`]: '',
            [`${M1}/reg/sub/m1.js`]: '',
            [`${M2}/reg/c.js`]: '',
            [`${M2}/other/only.js`]: '',
        });
        fs.mkdirSync(path.join(fx.core, 'utils'), { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'treeDir.js'), path.join(fx.core, 'utils', 'treeDir.js'));
    });
    after(() => fx.remove());

    // The probe sits in <core>/probe/; `rel` writes a path relative to the core root.
    const HEAD = [
        "const path = require('path');",
        "const t = require('../utils/treeDir');",
        "const CORE = path.join(__dirname, '..');",
        'const rel = (p) => path.relative(CORE, p).split(path.sep).join("/");',
        '',
    ].join('\n');
    /** @param {string} name @param {string} body @param {Record<string, string>} [env] */
    const probe = (name, body, env) => runProbe(fx, name, HEAD + body, env ? { env } : {});

    test('dirEntries joins a directory over every root, by name, from whichever root it is asked', () => {
        const r = probe('entries', `out([
            t.dirEntries(path.join(CORE, 'reg')).map((e) => [e.name, rel(e.abs)]),
            t.dirEntries(path.join(CORE, '..', ${JSON.stringify(M2)}, 'reg')).map((e) => e.name),
        ]);`);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(r.value[0], [
            ['a.js', `../${M1}/reg/a.js`], ['b.js', 'reg/b.js'], ['c.js', `../${M2}/reg/c.js`], ['sub', 'reg/sub'],
        ]);
        assert.deepStrictEqual(r.value[1], ['a.js', 'b.js', 'c.js', 'sub']);
    });

    test('walkTreeFiles keys every file by its path below the directory, whichever root holds it', () => {
        const r = probe('walk', 'out([...t.walkTreeFiles(path.join(CORE, "reg"))].map((f) => [f.rel, rel(f.abs)]));');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(r.value, [
            ['a.js', `../${M1}/reg/a.js`], ['b.js', 'reg/b.js'], ['c.js', `../${M2}/reg/c.js`],
            ['sub/deep.js', 'reg/sub/deep.js'], ['sub/m1.js', `../${M1}/reg/sub/m1.js`],
        ]);
    });

    test('treeFileAt finds a file in the root that holds it', () => {
        const r = probe('at', 'out(rel(t.treeFileAt(path.join(CORE, "other", "only.js"))));');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(r.value, `../${M2}/other/only.js`);
    });

    test('a hidden module is not seen', () => {
        const r = probe('hidden', 'out(t.dirEntries(path.join(CORE, "reg")).map((e) => e.name));', { BEEFLOW_HIDE_MODULES: 'm1' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(r.value, ['b.js', 'c.js', 'sub']);
    });
});
