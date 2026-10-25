import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { culpritsFor, parseErrors, requiresOf, settle } from './typecheck-settle.mjs';

test('parseErrors and requiresOf', () => {
    assert.deepEqual(parseErrors("a/b.js(12,3): error TS2339: x\n  more\nc.js(1,1): error TS7006: y  [noImplicitAny level]\nFound"), [{ file: 'a/b.js', line: 12 }, { file: 'c.js', line: 1 }]);
    const r = requiresOf("const { a, b: c } = require('./x');\nconst y = require('../y');\nconst z = require('pg');\n");
    assert.deepEqual([...r.names], [['a', './x'], ['c', './x'], ['y', '../y']]);
    assert.deepEqual(r.specs, ['./x', '../y']);
});

function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'settle-'));
    const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    mkdirSync(path.join(dir, 'server'));
    const w = (f, t) => writeFileSync(path.join(dir, 'server', f), t);
    w('lib.js', 'module.exports = { f: (a) => a };\n');
    w('deep.js', "const { f } = require('./lib');\nmodule.exports = { g: () => f(1) };\n");
    w('user.js', "const { f } = require('./lib');\nconst other = 1;\nf(other);\n");
    w('far.js', "const { g } = require('./deep');\ng();\n");
    w('alone.js', 'const x = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    w('lib.js', '/** @param {string} a */\nmodule.exports = { f: (a) => a };\n');
    return { dir, w };
}

test('an error in an unedited file undoes the edited file it names; in an edited file, that file', () => {
    const { dir } = repo();
    try {
        const out = 'user.js(3,1): error TS2345: Argument of type number is not assignable to parameter of type string.\n';
        const r = settle(out, { root: dir });
        assert.deepEqual(r.reverted, ['lib.js']);
        assert.equal(readFileSync(path.join(dir, 'server/lib.js'), 'utf8'), 'module.exports = { f: (a) => a };\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the nearest edited file in the require graph is blamed when the line names nothing', () => {
    const { dir } = repo();
    try {
        assert.deepEqual(culpritsFor('far.js', [{ line: 2 }], new Set(['lib.js']), path.join(dir, 'server')), ['lib.js']);
        assert.deepEqual(culpritsFor('alone.js', [{ line: 1 }], new Set(['lib.js']), path.join(dir, 'server')), []);
        assert.deepEqual(culpritsFor('lib.js', [{ line: 1 }], new Set(['lib.js']), path.join(dir, 'server')), ['lib.js']);
        const r = settle('alone.js(1,1): error TS2322: nothing to blame\n', { root: dir, dryRun: true });
        assert.deepEqual(r.blameless, ['alone.js']);
        assert.equal(readFileSync(path.join(dir, 'server/lib.js'), 'utf8').startsWith('/**'), true, 'a dry run touches nothing');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
