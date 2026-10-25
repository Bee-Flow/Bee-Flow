import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, unionText, wrapEdits, writableType } from './jsdoc-widen-initializers.mjs';

test('writableType refuses any, never, empty objects and long types', () => {
    assert.equal(writableType('string'), true);
    assert.equal(writableType('{ a: string }'), true);
    for (const t of ['any', 'string[] | never', '{}', 'Array<unknown>', '', 'x'.repeat(121)]) assert.equal(writableType(t), false, t);
});

test('unionText drops duplicates and the null/undefined the caller adds itself', () => {
    assert.equal(unionText(['string', 'number', 'string', 'null', 'undefined']), 'string | number');
    assert.equal(unionText([]), '');
});

test('wrapEdits is an open and a close insert around the initializer', () => {
    assert.deepEqual(wrapEdits(10, 14, 'string | null'), [{ at: 10, text: '/** @type {string | null} */ (' }, { at: 14, text: ')' }]);
});

function sandbox(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'widen-'));
    writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'node20', moduleResolution: 'node16', allowJs: true, checkJs: true, noEmit: true, strict: false, types: [] },
        include: ['*.js'],
    }));
    mkdirSync(path.join(dir, 'x'));
    for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
    return dir;
}

test('a null property and an empty array take the type of what the file puts in them later', () => {
    const dir = sandbox({
        'a.js': [
            'const state = { when: null, rows: [] };',
            'function start() {',
            '    state.when = new Date();',
            '    state.rows.push({ id: "a", n: 1 });',
            '}',
            'module.exports = { state, start };',
            '',
        ].join('\n'),
    });
    try {
        const report = run({ files: [path.join(dir, 'a.js')], write: true, serverDir: dir });
        const text = readFileSync(path.join(dir, 'a.js'), 'utf8');
        assert.match(text, /when: \/\*\* @type \{Date \| null\} \*\/ \(null\)/);
        assert.match(text, /rows: \/\*\* @type \{\{ id: string; n: number; \}\[\]\} \*\/ \(\[\]\)/);
        assert.equal(report[0].kept, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('nothing is written when the later values do not settle on a type', () => {
    const dir = sandbox({ 'b.js': 'const s = { v: null };\nfunction f(x) { s.v = x; }\nmodule.exports = { s, f };\n' });
    try {
        const report = run({ files: [path.join(dir, 'b.js')], write: true, serverDir: dir });
        assert.equal(readFileSync(path.join(dir, 'b.js'), 'utf8'), 'const s = { v: null };\nfunction f(x) { s.v = x; }\nmodule.exports = { s, f };\n');
        assert.deepEqual(report, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
