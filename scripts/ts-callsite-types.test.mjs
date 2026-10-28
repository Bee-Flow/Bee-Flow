// The inference rules added after wave 3 (see .claude/handoff/ts-conversion/wave3/LESSONS.md):
// nullability from call sites, an explicit undefined as an omitted argument, typed
// empty arrays, props a caller passes but the component does not destructure,
// props the body guards, no `{}`/`Object`/type-parameter types, and the JSDoc path
// not typing the same slot twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, guardedInBody, hasDeclaredType, inferFile, jsdocTypedefNames, resetCaches, setSiteFilter } from './ts-callsite-types.mjs';
import { lowerToJsDoc } from './jsdoc-lower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }
const skip = !ts && 'agent-hub typescript not installed';

function serviceOver(files, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-callsite-'));
    const texts = new Map(Object.entries(files).map(([f, t]) => [path.join(dir, f), t]));
    const options = { strict: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [], ...extra };
    const host = {
        getScriptFileNames: () => [...texts.keys()],
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => { const t = texts.has(f) ? texts.get(f) : ts.sys.readFile(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
        getCurrentDirectory: () => dir,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => texts.has(f) || ts.sys.fileExists(f),
        readFile: (f) => (texts.has(f) ? texts.get(f) : ts.sys.readFile(f)),
    };
    return { service: ts.createLanguageService(host), at: (f) => path.join(dir, f), texts };
}

const infer = (svc, f) => { resetCaches(); return applyEdits(svc.texts.get(svc.at(f)), inferFile(ts, svc.service, svc.at(f)).edits); };

test('jsdocTypedefNames reads names with nested braces; hasDeclaredType sees JSDoc in a .js file', { skip }, () => {
    assert.deepEqual([...jsdocTypedefNames('/** @typedef {{ a: { b: string } }} Deep */\n/** @typedef {import("./x").T} T */\n/** @typedef Plain */')], ['Deep', 'T', 'Plain']);
    const sf = ts.createSourceFile('a.js', '/** @param {string} x */\nfunction f(x, y) {}\n/** @type {number} */\nlet n;\nlet m;\n', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const [fn, nStmt, mStmt] = sf.statements;
    assert.equal(hasDeclaredType(ts, fn.parameters[0]), true);
    assert.equal(hasDeclaredType(ts, fn.parameters[1]), false);
    assert.equal(hasDeclaredType(ts, nStmt.declarationList.declarations[0]), true);
    assert.equal(hasDeclaredType(ts, mStmt.declarationList.declarations[0]), false);
});

test('a caller that passes null gives `T | null`; one that passes undefined or leaves it out makes it optional', { skip }, () => {
    const svc = serviceOver({
        'f.ts': 'export function f(a, b, c) { return String(a) + String(b) + String(c); }\n',
        'use.ts': "import { f } from './f';\nf('x', 1, true);\nf(null, undefined, true);\n",
    });
    assert.match(infer(svc, 'f.ts'), /f\(a: string \| null, b\?: number, c: boolean\)/);
});

test('without strictNullChecks a null argument still ends as `| null`, not `any`', { skip }, () => {
    const svc = serviceOver({
        'f.ts': 'export function f(a) { return String(a); }\n',
        'use.ts': "import { f } from './f';\nf('x');\nf(null);\n",
    }, { strict: false, strictNullChecks: false, noImplicitAny: true });
    assert.match(infer(svc, 'f.ts'), /f\(a: string \| null\)/);
});

test('`{}`, Object and a type parameter of the caller are not written; a lone capital is a leaked T', { skip }, () => {
    const svc = serviceOver({
        'f.ts': 'export function f(a) { return a; }\nexport function g(b) { return b; }\nexport function h<T>(x: T) { return k(x); }\nexport function k(c) { return c; }\n',
        'use.ts': "import { f, g } from './f';\nf({});\nconst o: Object = {}; g(o);\n",
    });
    const out = infer(svc, 'f.ts');
    assert.doesNotMatch(out, /a: \{\}|b: Object|c: T\b/);
});

test('callers passing literals keep a literal union the body is held to; otherwise a literal widens', { skip }, () => {
    const svc = serviceOver({
        'f.ts': "export type State = 'unknown' | 'local' | 'eu';\nexport function blank(state): { state: State } { return { state }; }\nexport function label(kind) { return String(kind); }\n",
        'use.ts': "import { blank, label } from './f';\nblank('local'); blank('eu'); blank(Math.random() > 0.5 ? 'local' : 'unknown'); label('a'); label('b');\n",
    });
    const out = infer(svc, 'f.ts');
    assert.match(out, /blank\(state: State\)/); // the union, by its alias
    assert.match(out, /label\(kind: string\)/);
});

test('an object type with a member typed null alone is not written: a later assignment would fill it', { skip }, () => {
    const svc = serviceOver({
        'n.ts': "export function f(rules: { network: string; pop: string | null }[]) { let found = null; for (const r of rules) { if (r.pop) return { network: r.network, pop: r.pop }; found = found || { network: r.network, pop: null }; } return found; }\n",
    });
    assert.doesNotMatch(infer(svc, 'n.ts'), /let found: /);
});

test('an empty array literal takes T from what is pushed, assigned by index or reassigned', { skip }, () => {
    const svc = serviceOver({
        'a.ts': "export function f(k: number) { const out = []; out.push('a'); const idx = []; idx[k] = 1; let all = []; all = ['x', 'y']; const mixed = []; mixed.push(1); mixed.push('s'); return [out, idx, all, mixed]; }\n",
    });
    const out = infer(svc, 'a.ts');
    assert.match(out, /const out: string\[\] = \[\]/);
    assert.match(out, /const idx: number\[\] = \[\]/);
    assert.match(out, /let all: string\[\] = \[\]/);
    assert.match(out, /const mixed: \(string \| number\)\[\] = \[\]/);
});

test('a prop a caller passes that the component does not destructure is declared optional; one the body guards is optional', { skip }, () => {
    const svc = serviceOver({
        'Card.tsx': "export function Card({ label, hint }) { return <b title={hint || ''}>{label}</b>; }\n",
        'Use.tsx': "import { Card } from './Card';\nexport const U = () => <><Card label=\"a\" hint=\"h\" id=\"x\" /><Card label=\"b\" hint=\"h\" /></>;\n",
    });
    const out = infer(svc, 'Card.tsx');
    assert.match(out, /interface CardProps \{\n {4}label: string;\n {4}hint\?: string;\n {4}id\?: string;\n\}/);
});

test('an object literal argument\'s extra keys are declared; a typed variable\'s whole shape is not', { skip }, () => {
    const svc = serviceOver({
        'opts.ts': 'export function run({ a }) { return a; }\nexport function run2({ a }) { return a; }\n',
        'use.ts': "import { run, run2 } from './opts';\nrun({ a: 1, verbose: true });\ninterface Big { a: number; x: string; y: string }\ndeclare const big: Big;\nrun2(big);\n",
    });
    const out = infer(svc, 'opts.ts');
    assert.match(out, /type RunArgs = \{\n {4}a: number;\n {4}verbose\?: boolean;\n\};/);
    assert.match(out, /type Run2Args = \{\n {4}a: number;\n\};/);
});

test('guardedInBody: ?. ?? || && if(!x) typeof and == null count; a plain read does not', { skip }, () => {
    const svc = serviceOver({
        'g.ts': 'export function g({ a, b, c, d, e, f, plain }) { a?.x; b ?? 1; c || 2; if (!d) return; typeof e; f == null; return plain.x; }\n',
    });
    const program = svc.service.getProgram(); const checker = program.getTypeChecker();
    const fn = program.getSourceFile(svc.at('g.ts')).statements[0];
    const by = Object.fromEntries(fn.parameters[0].name.elements.map((el) => [el.name.text, el.name]));
    resetCaches();
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(guardedInBody(ts, svc.service, program, checker, by[k]), true, k);
    assert.equal(guardedInBody(ts, svc.service, program, checker, by.plain), false);
});

test('JavaScript: a slot typed in pass 1 is not typed again in pass 2 (no stacked typedefs or @type lines)', { skip }, () => {
    const files = {
        'opts.js': "'use strict';\nfunction start({ port, host }) { let timer = null; timer = setTimeout(() => {}, port); return host + String(timer); }\nmodule.exports = { start };\n",
        'use.js': "'use strict';\nconst { start } = require('./opts');\nstart({ port: 1, host: 'h' });\n",
    };
    const svc = serviceOver(files, { allowJs: true, checkJs: true, noImplicitAny: true, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 });
    setSiteFilter((f) => !/\.test\.[cm]?js$/.test(f));
    try {
        resetCaches();
        const f = svc.at('opts.js');
        const inf1 = inferFile(ts, svc.service, f);
        const once = applyEdits(files['opts.js'], lowerToJsDoc(files['opts.js'], inf1.edits).edits);
        assert.match(once, /@typedef \{\{ port: number, host: string \}\} StartArgs/);
        assert.match(once, /\{ let \/\*\* @type \{number \| null\} \*\/ timer = null;/);
        // pass 2 over the result: nothing left to type
        const svc2 = serviceOver({ ...files, 'opts.js': once }, { allowJs: true, checkJs: true, noImplicitAny: true, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 });
        resetCaches();
        const inf2 = inferFile(ts, svc2.service, svc2.at('opts.js'));
        assert.deepEqual(inf2.edits.filter((e) => e.kind !== 'imports'), []);
    } finally {
        setSiteFilter((f) => !(/\.(test|spec)\.[jt]sx?$/.test(f) || /\.[cm]?jsx?$/.test(f) || /\/__tests__\/|\/test-utils?\/|\/testUtils\//.test(f)));
    }
});
