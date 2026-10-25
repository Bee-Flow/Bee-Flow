import assert from 'node:assert';
import { test } from 'node:test';

import { codeLineCount, isCodeFile } from './code-lines.mjs';

test('block and JSDoc comments do not count', () => {
    assert.strictEqual(codeLineCount('/**\n * Doc\n * @param {string} a\n */\nconst a = 1;\n'), 1);
    assert.strictEqual(codeLineCount('/* one */\n/* two\nthree */\nx();'), 1);
});

test('line comments do not count, code with a trailing comment does', () => {
    assert.strictEqual(codeLineCount('// @typecheck\n// more\nconst a = 1; // why\n'), 1);
});

test('blank lines do not count', () => {
    assert.strictEqual(codeLineCount('a;\n\n   \n\t\nb;\n'), 2);
    assert.strictEqual(codeLineCount(''), 0);
});

test('comment markers inside strings are code', () => {
    assert.strictEqual(codeLineCount("const u = 'http://x';\nconst v = 2;"), 2);
    assert.strictEqual(codeLineCount('const s = "/* not a comment";\nconst t = 1;'), 2);
    assert.strictEqual(codeLineCount("const s = 'it\\'s // fine';\nb;"), 2);
});

test('template literals keep their lines and markers', () => {
    assert.strictEqual(codeLineCount('const t = `a\n// b\n/* c */\n${x}`;\nz;'), 5);
});

test('a block comment opened after code keeps the code line', () => {
    assert.strictEqual(codeLineCount('a(); /* start\nmiddle\n*/ b();'), 2);
});

test('isCodeFile', () => {
    for (const f of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.tsx', 'a.mts', 'a.cts']) assert.ok(isCodeFile(f), f);
    for (const f of ['a.py', 'a.json', 'a.md', 'a.d.ts.map']) assert.ok(!isCodeFile(f), f);
});
