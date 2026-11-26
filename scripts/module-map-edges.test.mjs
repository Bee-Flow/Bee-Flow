/**
 * The run-time import scanner of the ownership map: which specifiers count as edges, which are
 * type-only, which are lazy, and how a specifier resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importEdges, maskSource, resolveSpecifier, scanSource } from './module-map-edges.mjs';

const SOURCE = [
    "import type { A } from './typeonly';",
    "import { type B, type C } from './alltypes';",
    "import { type D, e } from './mixed';",
    'import x from "./static";',
    "export * from './reexport';",
    "export type { Q } from './retype';",
    "import './side';",
    "const a = require('./top');",
    "/** @type {import('./jsdoc').T} */",
    "// require('./comment')",
    "const s = \"require('./instring')\";",
    "const t = `require('./intemplate') ${require('./intplexpr')}`;",
    "const r = /require\\('\\.\\/inregex'\\)/;",
    "type Z = typeof import('./typeofimp');",
    "type Y = import('./typepos').Foo;",
    "function f() { return require('./lazyfn'); }",
    "const g = () => require('./lazyarrow');",
    "if (a) { require('./ifblock'); }",
    'const nodeRequire = createRequire(import.meta.url);',
    "nodeRequire('./noderequire');",
    "createRequire(import.meta.url)('./direct');",
    "async function h() { const m = await import('./dyn'); return (await import('./dyn2')).x; }",
    "class K { m() { return import('./method').then((v) => v); } }",
    "const o = { get p() { return require('./getter'); }, q: require('./objtop') };",
    "const div = a / 2; const k = require('./afterdiv');",
    "const pkg = require('express');",
].join('\n');

const bySpec = () => Object.fromEntries(scanSource(SOURCE).map((e) => [e.spec, e]));

test('every run-time form is an edge, with its line', () => {
    const found = bySpec();
    for (const spec of ['./mixed', './static', './reexport', './side', './top', './intplexpr', './lazyfn', './lazyarrow',
        './ifblock', './noderequire', './direct', './dyn', './dyn2', './method', './getter', './objtop', './afterdiv']) {
        assert.ok(found[spec], `missing ${spec}`);
    }
    assert.equal(found['./top'].line, 8);
    assert.equal(found['./afterdiv'].line, 25);
});

test('type-only references, comments, strings and regex literals are not edges', () => {
    const found = bySpec();
    for (const spec of ['./typeonly', './alltypes', './retype', './jsdoc', './comment', './instring', './intemplate',
        './inregex', './typeofimp', './typepos']) {
        assert.equal(found[spec], undefined, `${spec} must not be an edge`);
    }
});

test('package names are not edges: only relative specifiers count', () => {
    assert.equal(bySpec().express, undefined);
});

test('an edge inside a function body or an arrow body is lazy; a top-level block is not', () => {
    const found = bySpec();
    for (const spec of ['./lazyfn', './lazyarrow', './dyn', './dyn2', './method', './getter']) assert.equal(found[spec].lazy, true, spec);
    for (const spec of ['./top', './ifblock', './objtop', './static', './afterdiv']) assert.equal(found[spec].lazy, false, spec);
});

test('masking keeps the length and the newlines of the source', () => {
    const { code } = maskSource(SOURCE);
    assert.equal(code.length, SOURCE.length);
    assert.equal(code.split('\n').length, SOURCE.split('\n').length);
    assert.ok(!code.includes('instring'));
});

test('a specifier resolves like Node: extension, directory index, .js onto .mts', () => {
    const files = new Set(['a/b.js', 'a/c.mts', 'a/d/index.js', 'a/e.json', 'x.cts']);
    assert.equal(resolveSpecifier('a/z.js', './b', files), 'a/b.js');
    assert.equal(resolveSpecifier('a/z.js', './b.js', files), 'a/b.js');
    assert.equal(resolveSpecifier('a/z.js', './c.js', files), 'a/c.mts');
    assert.equal(resolveSpecifier('a/z.js', './c', files), 'a/c.mts');
    assert.equal(resolveSpecifier('a/z.js', './d', files), 'a/d/index.js');
    assert.equal(resolveSpecifier('a/z.js', './e', files), 'a/e.json');
    assert.equal(resolveSpecifier('a/z.js', '../x.cjs', files), 'x.cts');
    assert.equal(resolveSpecifier('a/z.js', '../../outside', files), null);
    assert.equal(resolveSpecifier('a/z.js', './missing', files), null);
});

test('importEdges reads the files and skips declaration files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-edges-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.js'), "const b = require('./b');\nfunction l() { return require('./c'); }\n");
        fs.writeFileSync(path.join(dir, 'b.js'), '');
        fs.writeFileSync(path.join(dir, 'c.mts'), "import type { T } from './b.js';\n");
        fs.writeFileSync(path.join(dir, 'a.d.ts'), "import { X } from './b';\n");
        const entries = ['a.js', 'b.js', 'c.mts', 'a.d.ts'].map((treePath) => ({ treePath, abs: path.join(dir, treePath) }));
        assert.deepEqual(importEdges(entries), [
            { from: 'a.js', to: 'b.js', line: 1, lazy: false },
            { from: 'a.js', to: 'c.mts', line: 2, lazy: true },
        ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
