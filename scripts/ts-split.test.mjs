/**
 * ts-split: the split has to keep every importer working (the result is really
 * required / imported here), carry the JSDoc along, add only the imports the
 * moved code needs, and REFUSE a move that would import back.
 */

import nodeTest from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The policy job runs the repo-script tests with only the root packages, so
// without agent-hub's typescript these tests skip (as ts-move-types.test.mjs does).
let hasTs = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); hasTs = true; } catch { /* not installed */ }
const test = hasTs ? nodeTest : nodeTest.skip;
const { split } = hasTs ? await import('./ts-split.mjs') : {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-split-'));
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

const CJS = `// @typecheck
'use strict';
const path = require('node:path');
const { join: joinPath } = require('./lib');

/**
 * The folder every report goes to.
 * @type {string}
 */
const BASE = joinPath('reports', 'out');

// Builds one path.
function reportPath(name) {
    return path.join(BASE, name);
}

function describe(name) {
    return \`report \${reportPath(name)}\`;
}

const COUNTER = { n: 0 };
function next() { COUNTER.n += 1; return COUNTER.n; }

module.exports = { reportPath, describe, BASE, next };
`;
const LIB = "exports.join = (...p) => p.join('/');\n";

test('CommonJS: moved declarations leave, the same module.exports keys survive, an importer still works', () => {
    const dir = fixture({ 'report.js': CJS, 'lib.js': LIB, 'user.js': "const r = require('./report');\nmodule.exports = [r.reportPath('a'), r.describe('b'), r.BASE, r.next()];\n" });
    const before = require(path.join(dir, 'user.js'));
    const { exitCode, result } = split({ file: path.join(dir, 'report.js'), move: ['BASE', 'reportPath', 'describe'], to: path.join(dir, 'reportPaths.js') });
    assert.equal(exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.moved, ['BASE', 'reportPath', 'describe']);
    const old = read(dir, 'report.js');
    const sib = read(dir, 'reportPaths.js');
    assert.match(old, /^\/\/ @typecheck\n'use strict';/, 'header kept');
    assert.match(old, /const \{ BASE, reportPath, describe \} = require\('\.\/reportPaths'\);/);
    assert.match(old, /module\.exports = \{ reportPath, describe, BASE, next \};/, 'exports line untouched');
    assert.doesNotMatch(old, /function reportPath/);
    assert.doesNotMatch(old, /node:path/, 'the import only the moved code used is gone');
    assert.doesNotMatch(old, /joinPath/);
    assert.match(sib, /^\/\/ @typecheck\n/, 'typecheck header added to the sibling');
    assert.match(sib, /const path = require\('node:path'\);/);
    assert.match(sib, /const \{ join: joinPath \} = require\('\.\/lib'\);/);
    assert.match(sib, /module\.exports = \{ BASE, reportPath, describe \};/);
    for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
    const after = require(path.join(dir, 'user.js'));
    assert.deepEqual(after, before);
});

test('JSDoc and comment lines travel with the declaration; free-standing ones stay', () => {
    const dir = fixture({ 'report.js': `${CJS.replace('// Builds one path.', '// A free-standing note.\n\n// Builds one path.')}`, 'lib.js': LIB });
    split({ file: path.join(dir, 'report.js'), move: ['BASE', 'reportPath'], to: path.join(dir, 'reportPaths.js') });
    const sib = read(dir, 'reportPaths.js');
    assert.match(sib, /\/\*\*\n \* The folder every report goes to\.\n \* @type \{string\}\n \*\/\nconst BASE/);
    assert.match(sib, /\/\/ Builds one path\.\nfunction reportPath/);
    assert.doesNotMatch(sib, /free-standing/);
    assert.match(read(dir, 'report.js'), /\/\/ A free-standing note\./);
});

test('refused: a moved declaration that uses one that stays (exit 2, nothing written)', () => {
    const dir = fixture({ 'report.js': CJS, 'lib.js': LIB });
    const { exitCode, result } = split({ file: path.join(dir, 'report.js'), move: ['describe'], to: path.join(dir, 'x.js') });
    assert.equal(exitCode, 2);
    assert.deepEqual(result.moved, []);
    assert.equal(result.refused[0].name, 'describe');
    assert.deepEqual(result.refused[0].dependsOn, ['reportPath']);
    assert.equal(fs.existsSync(path.join(dir, 'x.js')), false);
    assert.equal(read(dir, 'report.js'), CJS);
});

test('refused: let/var used by staying code, unknown names, an existing sibling', () => {
    const dir = fixture({ 'report.js': CJS, 'lib.js': LIB, 'there.js': '' });
    const mut = split({ file: path.join(dir, 'report.js'), move: ['COUNTER'], to: path.join(dir, 'c.js'), dry: true });
    assert.equal(mut.exitCode, 0, 'a const is fine: next() uses it, so next must come too');
    const bad = split({ file: path.join(dir, 'report.js'), move: ['next'], to: path.join(dir, 'n.js') });
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.result.refused[0].dependsOn[0], 'COUNTER');
    assert.equal(split({ file: path.join(dir, 'report.js'), move: ['nope'], to: path.join(dir, 'm.js') }).exitCode, 2);
    const ex = split({ file: path.join(dir, 'report.js'), move: ['BASE'], to: path.join(dir, 'there.js') });
    assert.equal(ex.exitCode, 2);
    assert.match(ex.result.refused[0].reason, /exists/);
    const lets = fixture({ 'a.js': "let n = 0;\nfunction inc() { n += 1; }\nmodule.exports = { inc, get: () => n };\n" });
    const r = split({ file: path.join(lets, 'a.js'), move: ['n', 'inc'], to: path.join(lets, 'b.js') });
    assert.equal(r.exitCode, 2, 'get() stays and reads n');
    assert.match(r.result.refused[0].reason, /let\/var/);
});

test('ESM (.mjs): re-export keeps a real importer working, the import list is pruned', async () => {
    const dir = fixture({
        'math.mjs': `import { sqrt } from './root.mjs';
import { unusedHere } from './root.mjs';

/** Square of x. */
export function square(x) { return x * x; }

export function hyp(a, b) { return sqrt(square(a) + square(b)); }

export const TAU = 6.28;

export function area(r) { return square(r) * TAU / 2 + unusedHere; }
`,
        'root.mjs': 'export const sqrt = Math.sqrt; export const unusedHere = 0;\n',
        'user.mjs': "import { square, hyp, area, TAU } from './math.mjs';\nexport default [square(3), hyp(3, 4), area(1), TAU];\n",
    });
    const before = (await import(`${pathToFileURL(path.join(dir, 'user.mjs'))}?before`)).default;
    const { exitCode, result } = split({ file: path.join(dir, 'math.mjs'), move: ['square', 'hyp', 'TAU'], to: path.join(dir, 'mathParts.mjs') });
    assert.equal(exitCode, 0, JSON.stringify(result));
    const old = read(dir, 'math.mjs');
    assert.match(old, /import \{ square, TAU \} from '\.\/mathParts\.mjs';/, 'only what area() still uses');
    assert.match(old, /export \{ square, hyp, TAU \} from '\.\/mathParts\.mjs';/);
    assert.match(old, /import \{ unusedHere \} from '\.\/root\.mjs';/);
    assert.doesNotMatch(old, /import \{ sqrt \}/);
    const sib = read(dir, 'mathParts.mjs');
    assert.match(sib, /^import \{ sqrt \} from '\.\/root\.mjs';/);
    assert.match(sib, /\/\*\* Square of x\. \*\/\nexport function square/);
    assert.match(sib, /export const TAU/);
    const after = (await import(`${pathToFileURL(path.join(dir, 'user.mjs'))}?after`)).default;
    assert.deepEqual(after, before);
});

test('TypeScript: types get inline `type` modifiers, imports are re-based for another directory', () => {
    const dir = fixture({
        'src/model.ts': `import type { Row } from './row';
import { fmt } from '../util/fmt';

export interface Shape { rows: Row[] }

export type Pair = [Shape, Shape];

export function show(s: Shape): string { return s.rows.map(fmt).join(','); }

export function pairs(p: Pair): number { return show(p[0]).length; }
`,
        'src/row.ts': 'export type Row = string;\n',
        'util/fmt.ts': 'export const fmt = (s: string) => s;\n',
    });
    const { exitCode, result } = split({ file: path.join(dir, 'src/model.ts'), move: ['Shape', 'Pair', 'show'], to: path.join(dir, 'src/parts/model.parts.ts') });
    assert.equal(exitCode, 0, JSON.stringify(result));
    const old = read(dir, 'src/model.ts');
    assert.match(old, /import \{ type Pair, show \} from '\.\/parts\/model\.parts';/);
    assert.match(old, /export \{ type Shape, type Pair, show \} from '\.\/parts\/model\.parts';/);
    assert.doesNotMatch(old, /import \{ fmt \}/);
    assert.doesNotMatch(old, /import type \{ Row \}/);
    const sib = read(dir, 'src/parts/model.parts.ts');
    assert.match(sib, /import type \{ Row \} from '\.\.\/row';/);
    assert.match(sib, /import \{ fmt \} from '\.\.\/\.\.\/util\/fmt';/);
    assert.match(sib, /export interface Shape/);
});

test('--rewrite-importers (agent-hub style): importers follow; mocks are listed, never rewritten', () => {
    const dir = fixture({
        'agent-hub/src/mod.ts': 'export function a() { return 1; }\nexport function b() { return 2; }\nexport function c() { return a() + b(); }\n',
        'agent-hub/src/use.ts': "import { a, b, c } from './mod';\nimport { a as a2 } from './mod';\nexport const z = a() + b() + c() + a2();\n",
        'agent-hub/src/all.ts': "import { a, b } from './mod';\nexport { a } from './mod';\nexport const q = a() + b();\n",
        'agent-hub/src/mod.test.ts': "import { a } from './mod';\nvi.mock('./mod', () => ({ a: vi.fn() }));\n",
        'agent-hub/package.json': '{"name":"x"}',
    });
    const { exitCode, result } = split({ file: path.join(dir, 'agent-hub/src/mod.ts'), move: ['a', 'b'], to: path.join(dir, 'agent-hub/src/ab.ts'), rewriteImporters: true });
    assert.equal(exitCode, 0, JSON.stringify(result));
    assert.match(read(dir, 'agent-hub/src/use.ts'), /import \{ c \} from '\.\/mod';\nimport \{ a, b \} from '\.\/ab';/);
    assert.match(read(dir, 'agent-hub/src/use.ts'), /import \{ a as a2 \} from '\.\/ab';/);
    assert.match(read(dir, 'agent-hub/src/all.ts'), /import \{ a, b \} from '\.\/ab';\nexport \{ a \} from '\.\/ab';/);
    assert.match(read(dir, 'agent-hub/src/mod.test.ts'), /vi\.mock\('\.\/mod'/, 'mock path untouched');
    assert.deepEqual(result.mockReferences.map((m) => m.kind), ['mock']);
    assert.match(result.mockReferences[0].file, /mod\.test\.ts$/);
    assert.equal(result.touched.length, 4);
});

test('--rewrite-importers is refused under server/; mocks are listed without it', () => {
    const dir = fixture({
        'server/x.js': 'function a() {}\nmodule.exports = { a };\n',
        'server/x.test.js': "require.cache[require.resolve('./x')] = { exports: {} };\n",
    });
    const f = path.join(dir, 'server/x.js');
    const refused = split({ file: f, move: ['a'], to: path.join(dir, 'server/y.js'), rewriteImporters: true });
    assert.equal(refused.exitCode, 2);
    assert.match(refused.result.refused[0].reason, /agent-hub only/);
    const ok = split({ file: f, move: ['a'], to: path.join(dir, 'server/y.js'), dry: true });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.result.mockReferences[0].kind, 'require.cache');
    assert.equal(fs.existsSync(path.join(dir, 'server/y.js')), false, '--dry writes nothing');
});

test('CLI: JSON on stdout, exit 2 on a refusal', () => {
    const dir = fixture({ 'report.js': CJS, 'lib.js': LIB });
    const run = (...a) => spawnSync('node', [path.join(HERE, 'ts-split.mjs'), path.join(dir, 'report.js'), ...a], { encoding: 'utf8' });
    const refused = run('--move', 'describe', '--to', path.join(dir, 'd.js'));
    assert.equal(refused.status, 2);
    assert.equal(JSON.parse(refused.stdout).refused[0].name, 'describe');
    const dry = run('--move', 'BASE,reportPath,describe', '--to', path.join(dir, 'd.js'), '--dry');
    assert.equal(dry.status, 0);
    assert.deepEqual(Object.keys(JSON.parse(dry.stdout)).sort(), ['created', 'dry', 'lines', 'mockReferences', 'moved', 'refused', 'touched', 'warnings']);
});

const DESTR = `import { readFileSync } from 'node:fs';
const cfg = { a: 1, b: 2, c: 3 };
// the pair
export const { a, b } = cfg;
const k = 1, m = k + 1;
export function useA() { return a + 1; }
export function useC() { return cfg.c + m; }
`;

test('multi-name destructuring: moving one name splits the declaration first, behaviour identical', () => {
    const dir = fixture({ 'cfg.ts': DESTR });
    const { exitCode, result } = split({ file: path.join(dir, 'cfg.ts'), move: ['a', 'useA'], to: path.join(dir, 'cfgA.ts') });
    assert.equal(exitCode, 2, 'a is destructured from cfg, which stays: refused unless cfg moves too');
    assert.deepEqual(result.refused.find((r) => r.dependsOn)?.dependsOn, ['cfg']);
    const ok = split({ file: path.join(dir, 'cfg.ts'), move: ['cfg', 'a', 'useA'], to: path.join(dir, 'cfgA.ts') });
    assert.equal(ok.exitCode, 0, JSON.stringify(ok.result));
    assert.deepEqual(ok.result.splitDeclarations, ['a+b -> 2 declarations']);
    const old = read(dir, 'cfg.ts');
    const sib = read(dir, 'cfgA.ts');
    assert.match(sib, /export const \{ a \} = cfg;/);
    assert.match(old, /export const \{ b \} = cfg;/, 'b stays, split off');
    assert.match(old, /import \{ cfg, a, useA \} from '\.\/cfgA'|import \{[^}]*\bcfg\b[^}]*\} from '\.\/cfgA'/);
});

test('multi-name destructuring: all names listed moves the declaration whole; impure initializer is refused', () => {
    const dir = fixture({ 'cfg.ts': DESTR, 'imp.ts': 'export function make() { return { p: 1, q: 2 }; }\nexport const { p, q } = make();\nexport const z = p;\n' });
    const whole = split({ file: path.join(dir, 'cfg.ts'), move: ['cfg', 'a', 'b'], to: path.join(dir, 'ab.ts'), dry: true });
    assert.equal(whole.exitCode, 0, JSON.stringify(whole.result));
    assert.equal(whole.result.splitDeclarations, undefined);
    const bad = split({ file: path.join(dir, 'imp.ts'), move: ['make', 'p'], to: path.join(dir, 'p.ts'), dry: true });
    assert.equal(bad.exitCode, 2);
    assert.match(bad.result.refused[0].reason, /once per name/);
    const good = split({ file: path.join(dir, 'imp.ts'), move: ['make', 'p', 'q'], to: path.join(dir, 'p.ts'), dry: true });
    assert.equal(good.exitCode, 0, JSON.stringify(good.result));
});

test('multi-declarator const: one name moves, the other stays', () => {
    const dir = fixture({ 'two.ts': 'const k = 1, m = 2;\nexport function f() { return k; }\nexport function g() { return m; }\n' });
    const { exitCode, result } = split({ file: path.join(dir, 'two.ts'), move: ['k', 'f'], to: path.join(dir, 'k.ts') });
    assert.equal(exitCode, 0, JSON.stringify(result));
    assert.match(read(dir, 'two.ts'), /const m = 2;/);
    assert.match(read(dir, 'k.ts'), /const k = 1;/);
});

test('--closure grows the move set to everything the names reference', () => {
    const dir = fixture({ 'cl.ts': 'const SEP = ",";\nfunction cell(x: string) { return x + SEP; }\nexport function row(a: string) { return cell(a); }\nexport function other() { return 1; }\n' });
    const refused = split({ file: path.join(dir, 'cl.ts'), move: ['row'], to: path.join(dir, 'row.ts'), dry: true });
    assert.equal(refused.exitCode, 2);
    const { exitCode, result } = split({ file: path.join(dir, 'cl.ts'), move: ['row'], to: path.join(dir, 'row.ts'), closure: true });
    assert.equal(exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.closure, { requested: ['row'], added: ['cell', 'SEP'] });
    assert.deepEqual([...result.moved].sort(), ['SEP', 'cell', 'row']);
    assert.match(read(dir, 'cl.ts'), /function other/);
    assert.doesNotMatch(read(dir, 'cl.ts'), /SEP/);
});

test('--closure splits a destructuring on demand and still refuses a let used by staying code', () => {
    const dir = fixture({
        'cl.ts': 'const src = { a: 1, b: 2 };\nconst { a, b } = src;\nexport function useA() { return a; }\nexport function useB() { return b; }\n',
        'mut.ts': 'let n = 0;\nexport function inc() { n += 1; }\nexport function get() { return n; }\n',
    });
    const r = split({ file: path.join(dir, 'cl.ts'), move: ['useA'], to: path.join(dir, 'ua.ts'), closure: true, dry: true });
    assert.equal(r.exitCode, 0, JSON.stringify(r.result));
    assert.deepEqual([...r.result.moved].sort(), ['a', 'src', 'useA']);
    assert.deepEqual(r.result.splitDeclarations, ['a+b -> 2 declarations']);
    const m = split({ file: path.join(dir, 'mut.ts'), move: ['inc'], to: path.join(dir, 'inc.ts'), closure: true, dry: true });
    assert.equal(m.exitCode, 2);
    assert.match(m.result.refused[0].reason, /let\/var/);
});

test('warns about tests that stub by requiring-file path or read the file as text', () => {
    const dir = fixture({
        'server/x.js': 'function a() { return 1; }\nfunction b() { return a(); }\nmodule.exports = { a, b };\n',
        'server/x.test.js': [
            "const Module = require('module');",
            "const orig = Module._resolveFilename;",
            "Module._resolveFilename = function (req, parent, ...rest) {",
            "  if (parent && parent.filename.endsWith('x.js') && req === './dep') return '/stub';",
            "  return orig.call(this, req, parent, ...rest);",
            "};",
            "const fs = require('fs');",
            "const src = fs.readFileSync(require('path').join(__dirname, 'x.js'), 'utf8');",
            "delete require.cache[require.resolve('./x')];",
            "require.cache[__dirname + '/x.js'] = { exports: {} };",
            "const { a } = require('./x');",
        ].join('\n'),
    });
    const { exitCode, result } = split({ file: path.join(dir, 'server/x.js'), move: ['a', 'b'], to: path.join(dir, 'server/y.js'), dry: true });
    assert.equal(exitCode, 0, JSON.stringify(result));
    const kinds = result.testCouplings.map((w) => w.kind).sort();
    assert.deepEqual(kinds, ['reads-source', 'require.cache', 'require.cache', 'resolve-by-parent']);
    assert.ok(result.warnings.some((w) => /parent\.filename/.test(w)));
});
