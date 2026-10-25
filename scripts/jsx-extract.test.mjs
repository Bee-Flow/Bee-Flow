import nodeTest from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let ok = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); ok = true; } catch { /* not installed */ }
const test = ok ? nodeTest : nodeTest.skip;
const { extractFile, longComponents } = ok ? await import('./jsx-extract.mjs') : {};
const { createService, loadTs } = ok ? await import('./lib/ts-service.mjs') : {};

function sandbox(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-extract-'));
    const all = {
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*'] }),
        'src/jsx.d.ts': 'declare namespace JSX { interface IntrinsicElements { [tag: string]: any } interface Element {} }\n',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

const rows = (n, v) => Array.from({ length: n }, (_, i) => `                <li key={${i}}>{${v} + ${i}}</li>`).join('\n');
const SRC = `declare function useThing(): number;
export function Page({ title, count }: { title: string; count: number }) {
    const thing = useThing();
    const label = title + '!';
    return (
        <div>
            <section>
                <h2>{label}</h2>
                <ul>
${rows(18, 'count')}
                </ul>
            </section>
            <footer>
                <p>{useThing()}</p>
${Array.from({ length: 160 }, (_, i) => `                <span>{thing + ${i}}</span>`).join('\n')}
            </footer>
            <table>
                <tbody>
${rows(40, 'label')}
                </tbody>
            </table>
        </div>
    );
}
`;

test('longComponents finds a capitalised function over 200 lines', () => {
    const ts = loadTs();
    const sf = ts.createSourceFile('a.tsx', SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.deepEqual(longComponents(ts, sf).map((c) => c.name), ['Page']);
});

test('extracts the clean blocks as components, leaves the one that calls a hook', () => {
    const root = sandbox({ 'src/Page.tsx': SRC });
    const file = path.join(root, 'src/Page.tsx');
    const svc = createService(root, loadTs());
    const r = extractFile(svc, file);
    assert.equal(r.ok, true, JSON.stringify(r));
    const out = svc.read(file);
    assert.ok(r.extracted.length >= 1);
    for (const e of r.extracted) {
        assert.match(out, new RegExp(`<${e.name}\\b[^>]*/>`), `${e.name} is used as an element`);
        assert.match(out, new RegExp(`function ${e.name}\\(\\{`), `${e.name} takes one props object`);
    }
    assert.doesNotMatch(out, /newFunction/);
    assert.match(out, /<span>\{thing \+ 3\}<\/span>/, 'the block with the hook-fed value stays inline');
    assert.ok(out.split('\n').length < SRC.split('\n').length + 20);
});

test('a component under the limit is left alone', () => {
    const root = sandbox({ 'src/Small.tsx': 'export function Small() {\n    return <div><p>x</p></div>;\n}\n' });
    const svc = createService(root, loadTs());
    const r = extractFile(svc, path.join(root, 'src/Small.tsx'));
    assert.equal(r.ok, false);
});
