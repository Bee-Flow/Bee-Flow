// @typecheck
/**
 * typecheck.mjs drives the native compiler (TypeScript 7 has no JS API) with
 * checkJs on for the whole program, so it sees errors everywhere and must
 * filter them. What matters: an error in a marked file still fails the check,
 * and one in an unmarked file the marked file requires does not.
 *
 * Each test builds a throwaway server root (jsconfig.json, types/, a marked
 * file, an unmarked dependency) and runs the real script against it with the
 * server's own tsc.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkedFiles, levelOfText, parseDiagnostics, runTypecheck, strictFiles } from './typecheck.mjs';

function sandbox({ marked, dep }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'typecheck-'));
    writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'node20', allowJs: true, checkJs: false, noEmit: true, strict: false, noImplicitAny: false, types: [] },
    }));
    mkdirSync(path.join(dir, 'types'));
    writeFileSync(path.join(dir, 'types', 'globals.d.ts'), 'declare const SANDBOX_GLOBAL: number;\n');
    writeFileSync(path.join(dir, 'marked.js'), marked);
    writeFileSync(path.join(dir, 'dep.js'), dep);
    return dir;
}

const CLEAN_DEP = 'module.exports = { n: 1 };\n';
const BROKEN_DEP = '/** @type {number} */\nconst bad = "not a number";\nmodule.exports = { n: bad };\n';

test('an error in a marked file is reported with file, position and code', (t) => {
    const dir = sandbox({
        marked: '// @typecheck\nconst { n } = require("./dep");\n/** @type {string} */\nconst s = n;\nmodule.exports = { s, g: SANDBOX_GLOBAL };\n',
        dep: CLEAN_DEP,
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(checkedFiles(dir), ['marked.js']);
    const { diagnostics, crashed } = runTypecheck(checkedFiles(dir), { dir });
    assert.equal(crashed, false);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].file, 'marked.js');
    assert.equal(diagnostics[0].line, 4);
    assert.equal(diagnostics[0].code, 'TS2322');
});

test('an error in an unmarked dependency is not reported', (t) => {
    const dir = sandbox({
        marked: '// @typecheck\nconst { n } = require("./dep");\nmodule.exports = { n };\n',
        dep: BROKEN_DEP,
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { diagnostics, crashed, output } = runTypecheck(checkedFiles(dir), { dir });
    assert.equal(crashed, false);
    assert.match(output, /dep\.js\(2,7\): error TS2322/, 'tsc did check the dependency');
    assert.deepEqual(diagnostics, []);
});

test('--file mode checks one file and leaves no generated config behind', (t) => {
    const dir = sandbox({ marked: '// @typecheck\nmodule.exports = 1;\n', dep: BROKEN_DEP });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { diagnostics } = runTypecheck(['dep.js'], { dir, single: true });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].file, 'dep.js');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('.typecheck.')).length, 0);
    assert.equal(existsSync(path.join(dir, '.typecheck.tsconfig.json')), false);
});

test('parseDiagnostics folds continuation lines and keeps file-less errors', () => {
    const out = [
        "a.js(1,2): error TS2322: Type 'x' is not assignable to type 'y'.",
        "  Types of property 'z' are incompatible.",
        "error TS5023: Unknown compiler option 'nope'.",
        'Found 2 errors.',
    ].join('\n');
    const ds = parseDiagnostics(out);
    assert.equal(ds.length, 2);
    assert.match(ds[0].text, /\n {2}Types of property 'z'/);
    assert.equal(ds[1].file, null);
    assert.equal(ds[1].code, 'TS5023');
});

test('levels: `// @typecheck` is base, `// @typecheck noImplicitAny` is strict, a marker past the header window or a lookalike is neither', () => {
    assert.equal(levelOfText('// @typecheck\nx\n'), 'base');
    assert.equal(levelOfText("'use strict';\n// @typecheck noImplicitAny\n"), 'noImplicitAny');
    assert.equal(levelOfText('// @typecheck   noImplicitAny\n'), 'noImplicitAny');
    assert.equal(levelOfText('// @typecheck noImplicitAnything\n'), 'base');
    assert.equal(levelOfText(`${'\n'.repeat(40)}// @typecheck noImplicitAny\n`), null);
    assert.equal(levelOfText('// typecheck\n'), null);
});

test('strictFiles lists only the noImplicitAny files; checkedFiles still lists both levels', (t) => {
    const dir = sandbox({ marked: '// @typecheck\nmodule.exports = 1;\n', dep: '// @typecheck noImplicitAny\nmodule.exports = 2;\n' });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(checkedFiles(dir), ['dep.js', 'marked.js']);
    assert.deepEqual(strictFiles(dir), ['dep.js']);
});

test('noImplicitAny: an untyped parameter passes the base run and fails the strict one, with its own generated config', (t) => {
    const dir = sandbox({ marked: '// @typecheck noImplicitAny\nfunction f(a) { return a; }\nmodule.exports = { f };\n', dep: CLEAN_DEP });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const base = runTypecheck(['marked.js'], { dir });
    assert.deepEqual(base.diagnostics, []);
    const strict = runTypecheck(['marked.js'], { dir, noImplicitAny: true });
    assert.equal(strict.crashed, false);
    assert.equal(strict.diagnostics.length, 1);
    assert.equal(strict.diagnostics[0].code, 'TS7006');
    assert.equal(strict.diagnostics[0].file, 'marked.js');
    assert.ok(existsSync(path.join(dir, '.typecheck.noimplicitany.tsconfig.json')));
    assert.ok(existsSync(path.join(dir, '.typecheck.tsconfig.json')));
    // a single-file strict run leaves nothing behind
    runTypecheck(['marked.js'], { dir, single: true, noImplicitAny: true });
    assert.equal(readdirSync(dir).filter((f) => /^\.typecheck\.noimplicitany\.\d+\./.test(f)).length, 0);
});
