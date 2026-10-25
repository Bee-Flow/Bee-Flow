import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { concrete, run, typeInFix, withoutTag } from './jsdoc-loose-types.mjs';

test('concrete refuses what says nothing', () => {
    assert.equal(concrete('string'), true);
    assert.equal(concrete('{ id: string; }[]'), true);
    for (const t of ['any', 'unknown', 'object', 'null', 'string | any', '{}', 'never[]', 'Function', '']) assert.equal(concrete(t), false, t);
});

test('typeInFix reads the type of the named tag, braces and all', () => {
    assert.equal(typeInFix('\n * @param {{ a: string; }[]} items\n', 'items'), '{ a: string; }[]');
    assert.equal(typeInFix('/** @param {number} [n] */', 'n'), 'number');
    assert.equal(typeInFix('/** @param {number} other */', 'n'), null);
});

test('withoutTag takes the tag line out of a block, or the tag out of a one-line comment', () => {
    const block = '/**\n * Adds.\n * @param {any} a\n * @param {any} b\n */\nfunction f(a, b) {}\n';
    const at = block.indexOf('@param {any} a');
    assert.equal(withoutTag(block, { tagStart: at, tagEnd: at + '@param {any} a'.length }), '/**\n * Adds.\n * @param {any} b\n */\nfunction f(a, b) {}\n');
    const one = '/** @param {any} a */\nfunction f(a) {}\n';
    assert.equal(withoutTag(one, { tagStart: 4, tagEnd: 18 }), '/**  */\nfunction f(a) {}\n');
});

function sandbox(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'loose-'));
    writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'node20', moduleResolution: 'node16', allowJs: true, checkJs: true, noEmit: true, strict: false, types: [] },
        include: ['*.js'],
    }));
    for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
    return dir;
}

test('a loose parameter takes the type its use and its callers give it; an unusable one stays', () => {
    const dir = sandbox({
        'a.js': [
            '/**',
            ' * @param {any} name',
            ' * @param {object} opts',
            ' */',
            'function greet(name, opts) {',
            '    return name.toUpperCase() + opts;',
            '}',
            'greet("a", {});',
            'module.exports = { greet };',
            '',
        ].join('\n'),
    });
    try {
        const report = run({ files: [path.join(dir, 'a.js')], write: true, serverDir: dir });
        const text = readFileSync(path.join(dir, 'a.js'), 'utf8');
        assert.match(text, /@param \{string\} name/);
        assert.equal(report[0].seen, 2);
        assert.ok(report[0].replaced >= 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
