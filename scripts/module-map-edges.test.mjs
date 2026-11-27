/**
 * The run-time import scanner of the ownership map: which specifiers count as edges, which are
 * type-only, which are lazy, and how a specifier resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importEdges, maskSource, resolveSpecifier, scanSource, viteLocal } from './module-map-edges.mjs';

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

const VITE = { style: /** @type {const} */ ('vite'), alias: { '@/': 'src/', '@shared/': 'src/shared/' } };

/**
 * A throwaway web-client tree on disk.
 * @param {Record<string, string>} files tree path -> content
 */
function viteTree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vite-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return Object.keys(files).map((treePath) => ({ treePath, abs: path.join(dir, treePath) }));
}

const edgeList = (entries) => importEdges(entries, VITE).map((e) => `${e.from}>${e.to}:${e.lazy ? 'lazy' : 'top'}`).sort();

test('the web client: the @/ alias, relative and root-absolute specifiers, tsx with JSX', () => {
    const entries = viteTree({
        'src/App.tsx': [
            "import { lazy } from 'react';",
            "import Button from '@/components/Button';",
            "import { format } from '@shared/expr';",
            "import './app.css';",
            "import raw from '/src/data/words.txt?raw';",
            "const Page = lazy(() => import('./pages/Page'));",
            "export default function App() { return <div title=\"don't\">it's <Button /> {format(raw)} <Page /></div>; }",
            "function later() { return import('@/pages/Other.js'); }",
        ].join('\n'),
        'src/components/Button.tsx': "import type { Props } from './Button.types';\nexport default function Button(p: Props) { return <button />; }\n",
        'src/components/Button.types.ts': 'export interface Props { x?: number }\n',
        'src/shared/expr/index.mjs': 'export const format = String;\n',
        'src/app.css': '',
        'src/data/words.txt': '',
        'src/pages/Page.tsx': '',
        'src/pages/Other.ts': '',
    });
    assert.deepEqual(edgeList(entries), [
        'src/App.tsx>src/app.css:top',
        'src/App.tsx>src/components/Button.tsx:top',
        'src/App.tsx>src/data/words.txt:top',
        'src/App.tsx>src/pages/Other.ts:lazy',
        'src/App.tsx>src/pages/Page.tsx:lazy',
        'src/App.tsx>src/shared/expr/index.mjs:top',
    ]);
});

test('the web client: type-only imports and re-exports are not edges, a value import beside a type is', () => {
    const entries = viteTree({
        'src/a.ts': [
            "import type { T } from '@/types';",
            "import { type U } from './types';",
            "export type { V } from '@/types';",
            "import { type W, value } from '@/mixed';",
            "export { thing } from './things';",
        ].join('\n'),
        'src/types.ts': '',
        'src/mixed.ts': '',
        'src/things.tsx': '',
    });
    assert.deepEqual(edgeList(entries), ['src/a.ts>src/mixed.ts:top', 'src/a.ts>src/things.tsx:top']);
});

test('the web client: only import() is lazy; any other form is top-level, inside a function too', () => {
    const found = Object.fromEntries(scanSource("function f() { return import('./dyn'); }\nconst g = () => require('./req');\n").map((e) => [e.spec, e]));
    assert.equal(found['./dyn'].kind, 'dynamic');
    assert.equal(found['./req'].kind, 'call');
    const entries = viteTree({
        'src/f.ts': "const g = () => require('./req');\nexport const h = () => import('./dyn');\n",
        'src/req.ts': '',
        'src/dyn.ts': '',
    });
    assert.deepEqual(edgeList(entries), ['src/f.ts>src/dyn.ts:lazy', 'src/f.ts>src/req.ts:top']);
});

test('the web client: import.meta.glob is an edge to every match, lazy unless eager, ! takes files out', () => {
    const entries = viteTree({
        'src/i18n/index.ts': [
            "const lazyOnes = import.meta.glob('./en/*.mjs');",
            "const eagerOnes = import.meta.glob(['@/steps/*.ts', '!@/steps/*.test.ts'], { eager: true, import: 'default' });",
        ].join('\n'),
        'src/i18n/en/a.mjs': '',
        'src/i18n/en/b.mjs': '',
        'src/steps/one.ts': '',
        'src/steps/one.test.ts': '',
    });
    assert.deepEqual(edgeList(entries).map((e) => e.split('>')[1]), ['src/i18n/en/a.mjs:lazy', 'src/i18n/en/b.mjs:lazy', 'src/steps/one.ts:top']);
});

test('the web client resolves like Vite: extensions, index, .js onto .ts/.tsx, never a .d.ts', () => {
    const files = new Set(['src/a.ts', 'src/b.tsx', 'src/c/index.tsx', 'src/d.d.ts', 'src/e.jsx', 'src/f.json']);
    const r = (spec) => resolveSpecifier('src/z.tsx', spec, files, VITE);
    assert.equal(r('./a'), 'src/a.ts');
    assert.equal(r('./a.js'), 'src/a.ts');
    assert.equal(r('./b.js'), 'src/b.tsx');
    assert.equal(r('@/c'), 'src/c/index.tsx');
    assert.equal(r('./d'), null);
    assert.equal(r('./e'), 'src/e.jsx');
    assert.equal(r('./f.json?url'), 'src/f.json');
    assert.equal(r('../outside'), null);
    assert.equal(resolveSpecifier('src/z.ts', './b', files), null, 'node style keeps its own extension list');
});

test('a package name or a scoped package is not an edge in the web client', () => {
    const local = viteLocal(VITE.alias);
    assert.equal(local('@tanstack/react-query'), false);
    assert.equal(local('react'), false);
    assert.equal(local('@/x'), true);
    assert.equal(local('@shared/expr'), true);
    assert.equal(scanSource("import x from '@/x';").length, 0, 'the server scanner keeps relative specifiers only');
});
