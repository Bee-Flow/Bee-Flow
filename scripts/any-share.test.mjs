// Unit tests of the any-share ratchet: what counts as an expression and as
// `any`, which exported functions are flagged, the folder totals, and the
// budget verdict (a rise beyond the tolerance fails, --update only lowers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TEST_FILE, countExpressions, exportedFunctions, folderOf, loadTs, pct, summarise, verdict } from './any-share.mjs';

// The checker is the TypeScript API (root `typescript-api`). The workflow-policy
// job runs the scripts' tests without npm ci, so the checker cases skip there.
let ts = null;
try { ts = loadTs(); } catch { /* not installed */ }
const tsTest = ts ? test : test.skip;

/** A program over throwaway files; returns the checker and a getter for each source file. */
function program(files, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'any-share-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const p = ts.createProgram({
        rootNames: Object.keys(files).map((f) => path.join(dir, f)),
        options: { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, types: [], ...options },
    });
    return { checker: p.getTypeChecker(), file: (name) => p.getSourceFile(path.join(dir, name)), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

tsTest('an expression is counted once, literals and declaration names are not, and any spreads to what is computed from it', () => {
    const p = program({
        'a.ts': [
            'const typed: number = 1;',          // a declaration name and a literal: nothing counted
            'const parsed = JSON.parse("{}");',  // JSON, JSON.parse, JSON.parse("{}"): 3 counted, the call is any
            'const twice = typed + typed;',      // typed, typed, typed + typed: 3 counted, none any
            'const field = parsed.field;',       // parsed, parsed.field: 2 counted, both any
        ].join('\n'),
    });
    try {
        assert.deepEqual(countExpressions(ts, p.checker, p.file('a.ts')), { any: 3, total: 8 });
    } finally { p.done(); }
});

tsTest('JavaScript: an unannotated parameter is any and so is what is read from it; a JSDoc type ends that', () => {
    const p = program({
        'bare.js': 'function f(a) { return a.b; }\nmodule.exports = { f };\n',
        'typed.js': '/** @param {{ b: number }} a */\nfunction f(a) { return a.b; }\nmodule.exports = { f };\n',
    }, { strict: false });
    try {
        const bare = countExpressions(ts, p.checker, p.file('bare.js'));
        const typed = countExpressions(ts, p.checker, p.file('typed.js'));
        assert.equal(bare.total, typed.total);
        // a, a.b
        assert.equal(bare.any, 2);
        assert.equal(typed.any, 0);
    } finally { p.done(); }
});

tsTest('types and JSDoc hold no expressions', () => {
    const p = program({ 'a.ts': '/** @param {any} x */\ntype T = { a: any; b: Array<any> };\nexport const v: T | null = null;\n' });
    try {
        assert.deepEqual(countExpressions(ts, p.checker, p.file('a.ts')), { any: 0, total: 0 });
    } finally { p.done(); }
});

tsTest('exported functions: an any parameter, an any rest, an any or Promise<any> return are flagged; values and typed functions are not', () => {
    const p = program({
        'm.ts': [
            'export function typed(a: string): number { return a.length; }',
            'export function loose(a: any, b: string): string { return b + a; }',
            'export function rest(...xs: any[]): void { void xs; }',
            'export function gives(): any { return 1; }',
            'export async function later(s: string): Promise<any> { return JSON.parse(s); }',
            'export const arrow = (o: Record<string, unknown>) => Object.keys(o);',
            'export const VALUE = 3;',
            'function hidden(a: any) { return a; }',
            'void hidden;',
        ].join('\n'),
        'c.js': '/** @param {string} s */\nfunction ok(s) { return s.length; }\nfunction bare(x) { return x; }\nmodule.exports = { ok, bare };\n',
    }, { strict: false });
    try {
        assert.deepEqual(exportedFunctions(ts, p.checker, p.file('m.ts')), [
            { name: 'typed', any: [] },
            { name: 'loose', any: ['a'] },
            { name: 'rest', any: ['xs'] },
            { name: 'gives', any: ['return'] },
            { name: 'later', any: ['return'] },
            { name: 'arrow', any: [] },
        ]);
        // CommonJS: `module.exports = { … }` exports its properties.
        assert.deepEqual(exportedFunctions(ts, p.checker, p.file('c.js')), [
            { name: 'ok', any: [] },
            { name: 'bare', any: ['x', 'return'] },
        ]);
    } finally { p.done(); }
});

test('tests and test helpers are left out, sources are not', () => {
    for (const f of ['auth/x.test.js', 'a/b.test.mts', 'testUtils/pgliteDb.js', 'core/testUtils/x.js', 'stores/x.testkit.js']) assert.ok(TEST_FILE.test(f), f);
    for (const f of ['auth/x.js', 'core/latest/x.mts', 'usecases/contest.js', 'core/testing.js']) assert.ok(!TEST_FILE.test(f), f);
});

test('totals per top-level folder, the folder with the most any first', () => {
    assert.equal(folderOf('index.js'), '(root)');
    assert.equal(folderOf('core/llm/x.js'), 'core');
    const s = summarise([
        { file: 'core/a.js', expressions: { any: 1, total: 10 }, exports: [{ name: 'f', any: [] }] },
        { file: 'core/llm/b.js', expressions: { any: 2, total: 10 }, exports: [{ name: 'g', any: ['x'] }, { name: 'h', any: [] }] },
        { file: 'auth/c.js', expressions: { any: 9, total: 10 }, exports: [] },
    ]);
    assert.deepEqual(s.total, { files: 3, expressions: { any: 12, total: 30 }, exportedFunctions: { any: 1, total: 3 } });
    assert.deepEqual(s.folders.map((f) => [f.folder, f.files, f.expressions.any]), [['auth', 1, 9], ['core', 2, 3]]);
    assert.equal(pct(12, 30), 40);
    assert.equal(pct(1, 3), 33.33);
    assert.equal(pct(0, 0), 0);
});

test('the verdict: above budget plus tolerance fails, inside it passes, --update and a first run write, and never raise', () => {
    const total = (a, e) => ({ expressions: { any: a, total: 1000 }, exportedFunctions: { any: e, total: 100 } });
    const budget = { tolerance: 0.1, expressions: { any: 230, total: 1000, pct: 23 }, exportedFunctions: { any: 32, total: 100, pct: 32 } };
    assert.equal(verdict(total(230, 32), budget, false).status, 'at');
    assert.equal(verdict(total(231, 32), budget, false).status, 'at', 'inside the tolerance');
    assert.equal(verdict(total(220, 32), budget, false).status, 'under');
    assert.deepEqual(verdict(total(232, 32), budget, false).over, ['expressions']);
    assert.deepEqual(verdict(total(230, 33), budget, false).over, ['exportedFunctions']);
    // --update takes each number down on its own and leaves a higher measurement at the recorded one.
    const lowered = verdict(total(200, 40), budget, true);
    assert.equal(lowered.status, 'write');
    assert.deepEqual(lowered.next.expressions, { any: 200, total: 1000, pct: 20 });
    assert.deepEqual(lowered.next.exportedFunctions, budget.exportedFunctions);
    // No budget file yet: the measurement becomes the budget.
    assert.deepEqual(verdict(total(5, 1), null, false).next, { expressions: { any: 5, total: 1000, pct: 0.5 }, exportedFunctions: { any: 1, total: 100, pct: 1 } });
});
