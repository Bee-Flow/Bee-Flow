/**
 * The ratchet is a gate, so it has to REFUSE: a cycle that grew past its
 * budget, and an --update that would raise the budget. And it measures a
 * graph read with regular expressions, so it has to DISCRIMINATE: a lazy
 * require is an edge (that is how the server's big cycle hides), a comment
 * that mentions an import is not, and neither is an import TypeScript erases.
 *
 * Gate cases run the real script in a throwaway repo under os.tmpdir(), the
 * way scripts/count-ratchet.test.mjs does; the scanner cases call the
 * exported functions directly.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { importsOf, stripComments, stronglyConnected, typeOnlyClause } from './scc-ratchet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sandbox({ files = {}, budget = null, pkg = 'pkg', src = true, tsconfig = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    for (const f of ['scc-ratchet.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    const root = src ? path.join(dir, pkg, 'src') : path.join(dir, pkg);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    if (tsconfig !== null) fs.writeFileSync(path.join(dir, pkg, 'tsconfig.json'), tsconfig);
    if (budget !== null) fs.writeFileSync(path.join(dir, pkg, '.scc-ratchet.json'), JSON.stringify({ size: budget }));
    return dir;
}

function run(dir, extra = [], pkgs = ['pkg']) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/scc-ratchet.mjs'), ...pkgs, ...extra], {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir, pkg = 'pkg') => JSON.parse(fs.readFileSync(path.join(dir, pkg, '.scc-ratchet.json'), 'utf8')).size;

// a -> b -> c -> a: one cycle of three files.
const TRIANGLE = {
    'a.js': "const b = require('./b');\nmodule.exports = () => b;\n",
    'b.js': "const c = require('./c');\nmodule.exports = () => c;\n",
    'c.js': "module.exports = () => require('./a');\n",
};

test('a cycle larger than the budget fails, and says what to do instead', () => {
    const r = run(sandbox({ files: TRIANGLE, budget: 2 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /largest import cycle under pkg\/src has 3 files, budget is 2/);
    assert.match(r.stderr, /move the shared piece down/);
});

test('at or under the budget passes; under it points at --update', () => {
    assert.strictEqual(run(sandbox({ files: TRIANGLE, budget: 3 })).code, 0);
    const r = run(sandbox({ files: TRIANGLE, budget: 10 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 10/);
    assert.match(r.stdout, /--update/);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ files: TRIANGLE, budget: 10 });
    assert.strictEqual(run(lower, ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 3);

    const higher = sandbox({ files: TRIANGLE, budget: 2 });
    assert.strictEqual(run(higher, ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 2);
    assert.strictEqual(run(higher).code, 1);
});

test('without a budget file the measured size is written, with the comment and date', () => {
    const dir = sandbox({ files: TRIANGLE });
    assert.strictEqual(run(dir).code, 0);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.scc-ratchet.json'), 'utf8'));
    assert.strictEqual(written.size, 3);
    assert.match(written._comment, /--update/);
    assert.match(written._generated, /^\d{4}-\d{2}-\d{2}$/);
});

test('an acyclic tree measures 0', () => {
    const dir = sandbox({ files: { 'a.js': "require('./b');\n", 'b.js': 'module.exports = 1;\n' } });
    run(dir);
    assert.strictEqual(budgetOf(dir), 0);
});

test('--list names the files of the largest cycle', () => {
    const r = run(sandbox({ files: { ...TRIANGLE, 'x.js': "require('./y');\n", 'y.js': "require('./x');\n" }, budget: 3 }), ['--list']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /2 import cycles, sizes 3, 2/);
    assert.match(r.stdout, /Largest cycle \(3 files\):\n {2}src\/a\.js\n {2}src\/b\.js\n {2}src\/c\.js/);
});

test('a package without src/ is scanned whole, and several packages run in one call', () => {
    const dir = sandbox({ files: TRIANGLE, src: false, pkg: 'server', budget: 3 });
    fs.mkdirSync(path.join(dir, 'other/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'other/src/a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(dir, 'other/src/b.js'), "require('./a');\n");
    fs.writeFileSync(path.join(dir, 'other/.scc-ratchet.json'), JSON.stringify({ size: 1 }));
    const r = run(dir, [], ['server', 'other']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /server: largest import cycle 3 files, at budget/);
    assert.match(r.stderr, /other: the largest import cycle under other\/src has 2 files, budget is 1/);
});

test('usage errors exit 2', () => {
    assert.strictEqual(run(sandbox(), [], []).code, 2);
    assert.strictEqual(run(sandbox(), [], ['nope']).code, 2);
});

test('test files and __mocks__ are not part of the graph', () => {
    const dir = sandbox({
        files: {
            'a.js': "require('./helper.testkit');\nrequire('./__mocks__/m');\n",
            'helper.testkit.js': "require('./a');\n",
            '__mocks__/m.js': "require('../a');\n",
            'a.test.js': "require('./a');\n",
        },
    });
    run(dir);
    assert.strictEqual(budgetOf(dir), 0);
});

test('tsconfig path aliases resolve; tsconfig comments and trailing commas are tolerated', () => {
    const dir = sandbox({
        files: {
            'feature/a.ts': "import { b } from '@/feature/b';\nexport const a = () => b;\n",
            'feature/b.ts': "import { a } from '@shared/../feature/a';\nexport const b = () => a;\n",
        },
        tsconfig: '{\n  // JSONC\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], "@shared/*": ["./src/shared/*"], }, },\n}\n',
    });
    run(dir);
    assert.strictEqual(budgetOf(dir), 2);
});

test('a `.js` specifier finds the TypeScript source, and a ?query is ignored', () => {
    const dir = sandbox({
        files: {
            'a.ts': "import { b } from './b.js';\nexport const a = 1;\n",
            'b.tsx': "import raw from './a?raw';\nexport const b = raw;\n",
        },
    });
    run(dir);
    assert.strictEqual(budgetOf(dir), 2);
});

/* ---------------- scanner ---------------- */

test('lazy requires, spreads and dynamic imports are edges', () => {
    const src = [
        'function later() { return require("./lazy"); }',
        'module.exports = { ...require(\'./spread\') };',
        'const Page = React.lazy(() => import("./Page"));',
        'const t = require(`./tpl`);',
    ].join('\n');
    assert.deepStrictEqual(importsOf(src).sort(), ['./Page', './lazy', './spread', './tpl']);
});

test('member calls and computed specifiers are not edges', () => {
    const src = [
        "ctx.require('./member');",
        "require.resolve('./resolved');",
        'require(name);',
        'require(`./x/${name}`);',
        "foo.import('./method');",
    ].join('\n');
    assert.deepStrictEqual(importsOf(src), []);
});

test('an import mentioned in a comment is not an edge', () => {
    const src = [
        "// const x = require('./line');",
        "/* import { y } from './block'; */",
        '/**',
        " * Forms import it from '@/features/webpages', next to LinkActions.",
        " * @type {import('./jsdoc').T}",
        ' */',
        "const real = require('./real'); // see require('./trailing')",
    ].join('\n');
    assert.deepStrictEqual(importsOf(src), ['./real']);
});

test('type-only imports are not edges; a mixed import is', () => {
    const src = [
        "import type { A } from './typeOnly';",
        "import type B from './typeDefault';",
        "import { type C, type D } from './inlineTypes';",
        "export type { E } from './reexportType';",
        "export type * from './reexportAllTypes';",
        "type F = typeof import('./typeofImport');",
        "import G, { type H } from './mixed';",
        "import { type I, J } from './mixedBraces';",
        "export { K } from './valueReexport';",
        "export * from './star';",
        "import './sideEffect';",
        "import type from './defaultNamedType';",
    ].join('\n');
    assert.deepStrictEqual(importsOf(src).sort(), ['./defaultNamedType', './mixed', './mixedBraces', './sideEffect', './star', './valueReexport']);
});

test('typeOnlyClause reads the clause the way TypeScript erases it', () => {
    assert.strictEqual(typeOnlyClause('type { A }'), true);
    assert.strictEqual(typeOnlyClause('{ type A,\n  type B, }'), true);
    assert.strictEqual(typeOnlyClause('{}'), false);
    assert.strictEqual(typeOnlyClause('{ type A, B }'), false);
    assert.strictEqual(typeOnlyClause('type'), false);
});

test('comment markers inside strings, templates and regexes are not comments', () => {
    const src = [
        "const url = 'https://example.com'; require('./afterString');",
        'const re = /\\/\\/|["\']/g; require("./afterRegex");',
        'const t = `a ${ {x: "//"}.x } b /* c */`; require("./afterTemplate");',
        'const half = total / 2; const n = 4 / 2; require("./afterDivision");',
        'if (ok) { return /*/ still a comment */ 1; } require("./afterTrickyComment");',
    ].join('\n');
    assert.deepStrictEqual(importsOf(src), ['./afterString', './afterRegex', './afterTemplate', './afterDivision', './afterTrickyComment']);
    assert.strictEqual(stripComments('a /* x\ny */ b // z\nc'), 'a  \n  b  \nc');
});

test('an apostrophe in JSX text costs at most the rest of its line', () => {
    const src = "const A = () => <p>Don't panic</p>;\nimport { b } from './b';\n";
    assert.deepStrictEqual(importsOf(src), ['./b']);
});

test('stronglyConnected handles a deep chain without overflowing the stack', () => {
    const graph = new Map();
    const N = 50_000;
    for (let i = 0; i < N; i++) graph.set(i, new Set([(i + 1) % N]));
    const sccs = stronglyConnected(graph);
    assert.strictEqual(sccs.length, 1);
    assert.strictEqual(sccs[0].length, N);
});
