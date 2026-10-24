import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseAnys, analyseAnysMany, applyDepsChecked, depsFromCallsite, fileList, focus, openProject, overfitReason, typeAtPosition, typeOfSymbol } from './ts-type-at.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }
const skip = !ts && 'agent-hub typescript not installed';

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-type-at-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*'] }));
    fs.writeFileSync(path.join(dir, 'src/hook.ts'), [
        "export function useThing() { return { items: [1, 2, 3], label: 'x', save: (n: number) => n }; }",
        'export interface Deps { api: any; label: any; cb: any; }',
        'export function useDeps(d: Deps) { return d.label; }',
        'export function plain(x: any) { return x + 1; }',
        "export const y: any = 'str';",
        'export function cast(v: number) { return (v as any).toFixed(1); }',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'src/use.ts'), [
        "import { plain, useDeps, useThing } from './hook';",
        'const { items, save } = useThing();',
        "useDeps({ api: { get: () => 1 }, label: 'a', cb: (n: number) => n });",
        'plain(3);',
        'export const total = items.length + save(1);',
        '',
    ].join('\n'));
    return dir;
}

test('type at a position names the type and a shorter ReturnType form', { skip }, () => {
    const dir = fixture();
    const c = openProject(ts, dir, path.join(dir, 'src/use.ts'));
    const r = typeAtPosition(c, 2, 16); // `save`
    assert.equal(r.type, '(n: number) => number');
    assert.equal(r.declaredAt, 'src/use.ts:2');
    assert.equal(r.from, 'useThing');
    assert.equal(r.returnTypeForm, "ReturnType<typeof useThing>['save']");
    assert.equal(r.useReturnType, false); // the printed type is shorter
    const items = typeAtPosition(c, 2, 9);
    assert.equal(items.type, 'number[]');
    const sym = typeOfSymbol(c, 'total');
    assert.equal(sym.declarations[0].type, 'number');
});

test('--anys lists each explicit any with a replacement that typechecks', { skip }, () => {
    const dir = fixture();
    const c = openProject(ts, dir, path.join(dir, 'src/hook.ts'));
    const r = analyseAnys(c);
    const by = (kind, line) => r.anys.find((a) => a.kind === kind && a.line === line);
    assert.equal(r.anys.length, 6);
    const plain = by('parameter', 4);
    assert.equal(plain.best, 'number');
    assert.ok(plain.candidates.some((x) => x.source.startsWith('call sites') && x.replacement === 'number' && x.typechecks === true));
    assert.equal(by('variable', 5).best, 'string');
    const cast = by('cast', 6);
    assert.equal(cast.best, 'number');
    assert.equal(cast.candidates[0].typechecks, true);
});

test('--deps-from-callsite reads field types from the one call site', { skip }, () => {
    const dir = fixture();
    const c = openProject(ts, dir, path.join(dir, 'src/hook.ts'));
    const r = depsFromCallsite(c, 'Deps');
    assert.equal(r.exactlyOne, true);
    assert.deepEqual(r.callSites.map((s) => s.at), ['src/use.ts:3']);
    const f = Object.fromEntries(r.fields.map((x) => [x.name, x.fromCallSite]));
    assert.equal(f.api, '{ get: () => number; }');
    assert.equal(f.label, 'string');
    assert.equal(f.cb, '(n: number) => number');
    assert.match(r.suggestion, /label: string;/);
    assert.equal(depsFromCallsite(c, 'Nope').error?.includes('Nope'), true);
});

test('--anys: best carries typechecks, several files share one service', { skip }, () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'src/other.ts'), 'export function twice(n: any) { return n * 2; }\nexport const r = twice(2);\n');
    const files = [path.join(dir, 'src/hook.ts'), path.join(dir, 'src/other.ts')];
    const c = openProject(ts, dir, files);
    const many = analyseAnysMany(c, files);
    assert.equal(many.files.length, 2);
    assert.equal(many.summary.files, 2);
    assert.equal(many.summary.total, 7);
    const hook = many.files[0];
    assert.equal(hook.file, 'src/hook.ts');
    const plain = hook.anys.find((a) => a.kind === 'parameter' && a.line === 4);
    assert.equal(plain.best, 'number');
    assert.equal(plain.bestTypechecks, true);
    assert.equal(many.files[1].anys[0].best, 'number');
    // no verify: best is unchecked (null)
    const unchecked = analyseAnys(focus(c, files[1]), { verify: false });
    assert.equal(unchecked.anys[0].bestTypechecks, null);
    assert.throws(() => focus(c, path.join(dir, 'src/nope.ts')));
    // a file that cannot be read in does not stop the run
    const bad = analyseAnysMany(c, [...files, path.join(dir, 'src/missing.ts')]);
    assert.equal(bad.summary.failed, 1);
    assert.ok(bad.files[2].error);
});

test('fileList reads --files and a list file with comments', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-type-at-list-')), 'l.txt');
    fs.writeFileSync(f, '# c\nb.ts\n\nc.ts\n');
    assert.deepEqual(fileList('a.ts,b.ts', f), ['a.ts', 'b.ts', 'c.ts']);
});

test('overfit: a long inline object type, or a union for a named declared type', () => {
    assert.equal(overfitReason('{ a: string; }', null), null);
    assert.match(overfitReason(`{ ${'abcdefghij: string; '.repeat(8)}}`, null), /inline object type/);
    assert.match(overfitReason('A | B', 'Result<any>'), /named Result<any>/);
    assert.equal(overfitReason('A | B', 'any'), null);
    assert.equal(overfitReason('Map<string, A | B>', 'Foo'), null, 'a union inside generics is not a top-level union');
});

test('--deps-from-callsite --apply: types written, import() hoisted, typeof useX imported, comments kept', { skip }, () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'src/types.ts'), 'export interface Row { id: number }\nexport function useRows() { return { rows: [] as Row[], first: { id: 1 } as Row }; }\n');
    fs.writeFileSync(path.join(dir, 'src/panel.ts'), [
        '// the panel',
        'export interface PanelDeps {',
        '    // the rows',
        '    rows: any;',
        '    label?: any;',
        '    extra: any;',
        '}',
        'export function panel(d: PanelDeps) { return d.label; }',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'src/host.ts'), [
        "import { panel } from './panel';",
        "import { useRows } from './types';",
        'const r = useRows();',
        "panel({ rows: r, label: 'a', extra: r.first });",
        "panel({ rows: r, extra: r.first });",
        '',
    ].join('\n'));
    const c = openProject(ts, dir, path.join(dir, 'src/panel.ts'));
    const out = depsFromCallsite(c, 'PanelDeps');
    const res = applyDepsChecked(c, 'PanelDeps', out);
    assert.equal(res.error, undefined);
    assert.equal(res.typechecks, true, JSON.stringify(res.newErrors));
    assert.match(res.text, /\/\/ the rows\n    rows: [^;]+;/);
    assert.doesNotMatch(res.text, /import\("/);
    assert.doesNotMatch(res.text, /rows: any/);
    assert.match(res.text, /import type \{[^}]*\} from '\.\/types';/);
    assert.ok(res.changedFields.includes('rows'));
    assert.match(res.text, /\/\/ the panel\nexport interface PanelDeps/, 'the leading comment stays above the interface');
    assert.match(res.text, /label\?: string;/);
    assert.equal(c.original.includes('import type'), false);
});

test('--apply adds an import type for a typeof useX found through the call site', { skip }, () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'src/use-big.ts'), "export function useBig() { return { alpha: [1], beta: 'b', gamma: true, delta: { x: 1, y: 2 }, epsilon: new Date() }; }\n");
    fs.writeFileSync(path.join(dir, 'src/box.ts'), 'export interface BoxDeps { big: any }\nexport function box(d: BoxDeps) { return d.big; }\n');
    fs.writeFileSync(path.join(dir, 'src/box-host.ts'), "import { box } from './box';\nimport { useBig } from './use-big';\nconst big = useBig();\nbox({ big });\n");
    const c = openProject(ts, dir, path.join(dir, 'src/box.ts'));
    const res = applyDepsChecked(c, 'BoxDeps', depsFromCallsite(c, 'BoxDeps'));
    assert.match(res.text, /big: ReturnType<typeof useBig> \}/);
    assert.match(res.text, /import type \{ useBig \} from '\.\/use-big';/);
    assert.equal(res.typechecks, true, JSON.stringify(res.newErrors));
});
