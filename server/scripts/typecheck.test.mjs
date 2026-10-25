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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEVELS, MTS_OPTIONS, LEVEL_OPTIONS, checkLevels, checkedFiles, cleanAt, levelOfText, markedFiles, measure, parseDiagnostics, promote, runTypecheck, withLevel } from './typecheck.mjs';

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

test('an .mts file needs no marker and is checked strictly, with only erasable syntax', (t) => {
    const dir = sandbox({ marked: 'module.exports = {};\n', dep: CLEAN_DEP });
    writeFileSync(path.join(dir, 'tree.mts'), 'export const f = (x) => x;\nexport enum E { A }\nexport const ok: number = 1;\n');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(checkedFiles(dir), ['tree.mts'], 'listed without a marker, next to unmarked .js');
    const { diagnostics, crashed } = runTypecheck(['tree.mts'], { dir, level: 'mts' });
    assert.equal(crashed, false);
    assert.deepEqual(diagnostics.map((d) => d.code).sort(), ['TS1294', 'TS7006']);
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

// ---- levels, promote, measure ----


test('levelOfText reads the three markers from the header only', () => {
    assert.equal(levelOfText('// @typecheck\nx\n'), 'base');
    assert.equal(levelOfText("'use strict';\n// @typecheck noImplicitAny\nx\n"), 'noImplicitAny');
    assert.equal(levelOfText('#!/usr/bin/env node\n// @typecheck strict\n'), 'strict');
    assert.equal(levelOfText('x\n'.repeat(40) + '// @typecheck strict\n'), null);
    assert.equal(levelOfText('// the word @typecheck in prose\n'), null);
    assert.equal(levelOfText('// @typechecked\n'), null);
});

test('withLevel rewrites only the marker line', () => {
    assert.equal(withLevel("'use strict';\n// @typecheck\nx\n", 'noImplicitAny'), "'use strict';\n// @typecheck noImplicitAny\nx\n");
    assert.equal(withLevel('// @typecheck strict\nx\n', 'base'), '// @typecheck\nx\n');
    assert.equal(withLevel('x\n', 'strict'), 'x\n');
});

test('the strict level switches on the strict family and leaves catch variables alone', () => {
    assert.deepEqual(LEVELS, ['base', 'noImplicitAny', 'strict', 'mts']);
    assert.deepEqual(LEVEL_OPTIONS.mts, MTS_OPTIONS);
    assert.deepEqual(LEVEL_OPTIONS.base, {});
    assert.deepEqual(Object.keys(LEVEL_OPTIONS.strict).sort(), ['alwaysStrict', 'noImplicitAny', 'noImplicitThis', 'strictBindCallApply', 'strictFunctionTypes', 'strictNullChecks', 'useUnknownInCatchVariables']);
    assert.equal(LEVEL_OPTIONS.strict.useUnknownInCatchVariables, false);
});

function levelSandbox(files) {
    const dir = sandbox({ marked: '// @typecheck\nmodule.exports = 1;\n', dep: CLEAN_DEP });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
}

test('markedFiles includes .mts (always level mts, marker or not) and .cts, skips declarations, and reports each level', (t) => {
    const dir = levelSandbox({
        'a.mts': '// @typecheck strict\nexport const a: number = 1;\n',
        'b.cts': '// @typecheck noImplicitAny\nexport {};\n',
        'c.d.ts': '// @typecheck\ndeclare const c: number;\n',
        'd.js': 'module.exports = 1;\n',
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(markedFiles(dir), [
        { file: 'a.mts', level: 'mts' },
        { file: 'b.cts', level: 'noImplicitAny' },
        { file: 'marked.js', level: 'base' },
    ]);
    assert.deepEqual(checkedFiles(dir, '', 'mts'), ['a.mts']);
});

test('each level is checked under its own options: an implicit any fails only from noImplicitAny up', (t) => {
    const body = 'function f(x) { return x; }\nmodule.exports = { f };\n';
    const dir = levelSandbox({ 'base.js': `// @typecheck\n${body}`, 'nia.js': `// @typecheck noImplicitAny\n${body}` });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const runs = checkLevels(markedFiles(dir), { dir });
    const byLevel = Object.fromEntries(runs.map((r) => [r.level, r.diagnostics.map((d) => `${d.file}:${d.code}`)]));
    assert.deepEqual(byLevel.base, []);
    assert.deepEqual(byLevel.noImplicitAny, ['nia.js:TS7006']);
});

test('strict adds strictNullChecks: a nullable value used without a check fails there', (t) => {
    const body = '/** @param {string | null} s */\nfunction len(s) { return s.length; }\nmodule.exports = { len };\n';
    const dir = levelSandbox({ 's.js': `// @typecheck strict\n${body}`, 'n.js': `// @typecheck noImplicitAny\n${body}` });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const byLevel = Object.fromEntries(checkLevels(markedFiles(dir), { dir }).map((r) => [r.level, r.diagnostics.map((d) => d.file)]));
    assert.deepEqual(byLevel.strict, ['s.js']);
    assert.deepEqual(byLevel.noImplicitAny, []);
});

test('promote moves a clean file up (two levels when it can) and leaves a failing one, tests and all', (t) => {
    const clean = 'module.exports = { n: 1 };\n';
    const dir = levelSandbox({
        'clean.js': `// @typecheck\n${clean}`,
        'anyparam.js': '// @typecheck\nfunction f(x) { return x; }\nmodule.exports = { f };\n',
        'nullable.js': '// @typecheck\n/** @param {string | null} s */\nfunction len(s) { return s.length; }\nmodule.exports = { len };\n',
        'clean.test.js': `// @typecheck\n${clean}`,
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = promote({ dir });
    assert.equal(r.crashed, false);
    assert.deepEqual(r.promoted, { 'clean.js': 'strict', 'marked.js': 'strict', 'nullable.js': 'noImplicitAny' });
    assert.match(readFileSync(path.join(dir, 'clean.js'), 'utf8'), /^\/\/ @typecheck strict\n/);
    assert.match(readFileSync(path.join(dir, 'anyparam.js'), 'utf8'), /^\/\/ @typecheck\n/);
    assert.match(readFileSync(path.join(dir, 'nullable.js'), 'utf8'), /^\/\/ @typecheck noImplicitAny\n/);
    assert.match(readFileSync(path.join(dir, 'clean.test.js'), 'utf8'), /^\/\/ @typecheck\n/, 'tests stay');
    assert.equal(promote({ dir, tests: true }).promoted['clean.test.js'], 'strict');
});

test('measure counts the files per level and what the next level would say', (t) => {
    const dir = levelSandbox({
        'anyparam.js': '// @typecheck\nfunction f(x) { return x; }\nmodule.exports = { f };\n',
        'ok.js': '// @typecheck noImplicitAny\nmodule.exports = 1;\n',
    });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { rows, pending } = measure({ dir });
    assert.deepEqual(rows.map((r) => `${r.level}:${r.files}`), ['base:2', 'noImplicitAny:1', 'strict:0']);
    assert.equal(pending[0].to, 'noImplicitAny');
    assert.equal(pending[0].errors, 1);
    assert.equal(pending[0].clean, 1);
    assert.equal(pending[1].to, 'strict');
    assert.equal(pending[1].errors, 1, 'the untyped parameter fails there too');
    assert.equal(pending[1].clean, 2);
    assert.equal(cleanAt([], 'strict', { dir }).clean.length, 0);
});
