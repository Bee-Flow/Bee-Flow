import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, forbiddenInsert, targetName } from './ts-convert-codefix.mjs';
import { applyEdits, inferFile, resetCaches } from './ts-callsite-types.mjs';

test('a quick fix that writes any, Function or a ts- comment is refused', () => {
    assert.equal(forbiddenInsert(': any'), true);
    assert.equal(forbiddenInsert(': { a: any[] }'), true);
    assert.equal(forbiddenInsert(': Function'), true);
    assert.equal(forbiddenInsert('// @ts-expect-error'), true);
    assert.equal(forbiddenInsert(': string'), false);
    assert.equal(forbiddenInsert(': Company'), false); // `any` only as a whole word
});

test('.jsx becomes .tsx; .js becomes .tsx only when it holds JSX', () => {
    assert.equal(targetName('src/A.jsx', 'export const A = () => <div />;'), 'src/A.tsx');
    assert.equal(targetName('src/a.jsx', 'export const a = 1; // <Tag> in a comment'), 'src/a.ts');
    assert.equal(targetName('src/a.js', 'export const a = 1;'), 'src/a.ts');
    assert.equal(targetName('src/a.js', 'export const A = () => <div />;'), 'src/a.tsx');
    assert.equal(targetName('src/a.js', 'export const A = () => <>x</>;'), 'src/a.tsx');
    assert.equal(targetName('src/a.js', 'if (a < b) x();'), 'src/a.ts');
});

test('text changes and edits apply back to front, so offsets stay valid', () => {
    const text = 'function f(a, b) {}';
    assert.equal(applyChanges(text, [{ span: { start: 12, length: 0 }, newText: ': string' }, { span: { start: 15, length: 0 }, newText: ': number' }]),
        'function f(a: string, b: number) {}');
    // Two inserts at one offset keep their order (the JavaScript quick fix: `(`, the JSDoc type, `)`).
    assert.equal(applyEdits('x => x', [{ start: 0, end: 0, text: '(' }, { start: 1, end: 1, text: ': number)' }]), '(x: number) => x');
    assert.equal(applyChanges('t => t', [{ span: { start: 0, length: 0 }, newText: '(' }, { span: { start: 0, length: 0 }, newText: '/** @type {string} */ ' }, { span: { start: 1, length: 0 }, newText: ')' }]), '(/** @type {string} */ t) => t');
});

// The inference itself needs a TypeScript; agent-hub's is the one the converter
// uses. The policy job runs these tests with only the root packages: skip there.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }

function serviceOver(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-callsite-'));
    const texts = new Map(Object.entries(files).map(([f, t]) => [path.join(dir, f), t]));
    const options = { strict: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [] };
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

test('props come from the typed call sites, a missing one from what the body hands it to', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'types.ts': 'export interface User { id: string; name: string }\n',
        'Child.tsx': "import type { User } from './types';\nexport function Child(p: { user: User }) { return null; }\n",
        'Card.tsx': "import { Child } from './Child';\nexport function Card({ label, count, user }) { return <Child user={user} />; }\n",
        'Parent.tsx': "import { Card } from './Card';\nexport const P = () => <Card label=\"x\" count={2} />;\n",
    });
    resetCaches();
    const { edits, report } = inferFile(ts, service, at('Card.tsx'));
    if (process.env.DEBUG_INFER) console.log(report);
    const out = applyEdits(texts.get(at('Card.tsx')), edits);
    assert.match(out, /interface CardProps \{\n {4}label: string;\n {4}count: number;\n {4}user\?: User;\n\}/);
    assert.match(out, /Card\(\{ label, count, user \}: CardProps\)/);
    assert.match(out, /import type \{ User \} from '\.\/types';/);
});

test('useState([]) takes T from its setter calls; a literal widens', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'react.ts': 'export function useState<S>(s: S): [S, (v: S) => void] { return [s, () => {}]; }\n',
        'list.ts': "import { useState } from './react';\nexport function useList() { const [items, setItems] = useState([]); setItems(['a']); return items; }\n",
    });
    resetCaches();
    const { edits } = inferFile(ts, service, at('list.ts'));
    assert.match(applyEdits(texts.get(at('list.ts')), edits), /useState<string\[\]>\(\[\]\)/);
});

test('a callback prop is typed from how the body calls it; a guard makes it optional', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'Form.tsx': "export function Form({ onSave, onClose }) { const save = () => { onSave('x', 2); if (onClose) onClose(); }; return <button onClick={save} />; }\n",
    });
    resetCaches();
    const out = applyEdits(texts.get(at('Form.tsx')), inferFile(ts, service, at('Form.tsx')).edits);
    assert.match(out, /onSave: \(arg0: string, arg1: number\) => void;/);
    assert.match(out, /onClose\?: \(\) => void;/);
});

test('an options object gets a <Name>Args type alias (implicit index signature); `= {}` makes every member optional', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'span.ts': 'export function span({ dx, width } = {}) { return dx / width; }\n',
        'use.ts': "import { span } from './span';\nexport const s = span({ dx: 1, width: 2 });\n",
    });
    resetCaches();
    const out = applyEdits(texts.get(at('span.ts')), inferFile(ts, service, at('span.ts')).edits);
    assert.match(out, /type SpanArgs = \{\n {4}dx\?: number;\n {4}width\?: number;\n\};/);
    assert.match(out, /span\(\{ dx, width \}: SpanArgs = \{\}\)/);
});

test('an object grown after its literal gets the whole shape; one filled by key a Record', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'm.ts': "export function f(k: string) { const out = { views: 1 }; out.rate = 0.5; const byId = {}; byId[k] = 'x'; return [out, byId]; }\n",
    });
    resetCaches();
    const out = applyEdits(texts.get(at('m.ts')), inferFile(ts, service, at('m.ts')).edits);
    assert.match(out, /const out: \{ views: number; rate\?: number \} = \{ views: 1 \};/);
    assert.match(out, /const byId: Record<string, string> = \{\};/);
});

test('learned patterns: lookup tables, caught errors, late-assigned lets', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const { service, at, texts } = serviceOver({
        'l.ts': "const LABELS = { a: 'A', b: 'B' };\nexport function f(k: string) { let ro = null; ro = new Date(); try { return LABELS[k]; } catch (e) { return e.message + String(ro); } }\n",
    });
    resetCaches();
    const out = applyEdits(texts.get(at('l.ts')), inferFile(ts, service, at('l.ts')).edits);
    assert.match(out, /const LABELS: Record<string, string> = /);
    assert.match(out, /let ro: Date \| null = null;/);
    assert.match(out, /return \(e as Error\)\.message/);
});
