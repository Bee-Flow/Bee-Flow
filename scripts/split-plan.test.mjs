import nodeTest from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Like rq-codemod.test.mjs: skipped where agent-hub's typescript / esbuild are not installed.
let ok = false;
try {
    const req = createRequire(new URL('../agent-hub/package.json', import.meta.url));
    req('typescript');
    req('esbuild-wasm');
    ok = true;
} catch { /* not installed */ }
const test = ok ? nodeTest : nodeTest.skip;
const { planFile, equivalence, statementsOf, run, stemOf } = ok ? await import('./split-plan.mjs') : {};

const pad = (name, n) => Array.from({ length: n }, (_, i) => `    const ${name}${i} = ${i};`).join('\n');
const fn = (name, n, extra = '') => `function ${name}() {\n${pad(name.toLowerCase(), n)}\n${extra}    return 1;\n}\n`;

function sandbox(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-plan-'));
    const all = {
        'agent-hub/package.json': '{"name":"x","type":"module"}',
        'agent-hub/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*'] }),
        ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`agent-hub/${k}`, v])),
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return { root, hub: path.join(root, 'agent-hub'), at: (rel) => path.join(root, 'agent-hub', rel), read: (rel) => fs.readFileSync(path.join(root, 'agent-hub', rel), 'utf8') };
}

/** A component file with a types block, constants, a helper and two child components around the anchor. */
const BIG = `interface RowProps { id: string; label: string }
type Mode = 'a' | 'b';
${'// types padding\n'.repeat(0)}
export const TABLE = {
${Array.from({ length: 44 }, (_, i) => `    k${i}: ${i},`).join('\n')}
};

${fn('shorten', 44)}
function Header({ label }: { label: string }) {
    const x = shortenAll();
${pad('h', 44)}
    return label + x;
}

function shortenAll() { return shorten() + TABLE.k1; }

function Footer({ id }: { id: string }) {
${pad('f', 44)}
    return '<footer>' + id + '</footer>';
}

export default function Page({ id }: { id: string }) {
    const mode: Mode = 'a';
    return Header({ label: mode }) + Footer({ id });
}
`;

test('stemOf names a folder module after its folder', () => {
    assert.equal(stemOf('/x/Foo.tsx'), 'Foo');
    assert.equal(stemOf('/x/Foo/index.tsx'), 'Foo');
});

test('plan: roles, the 40-line floor, the pinned default export, flat versus folder', () => {
    const sb = sandbox({ 'src/Page.tsx': BIG });
    const p = planFile(sb.at('src/Page.tsx'), { limit: 100 });
    assert.equal(p.skip, null);
    const roles = Object.fromEntries(p.groups.map((g) => [g.role, g]));
    assert.ok(roles.constants, 'the TABLE data');
    assert.ok(roles.helpers, 'the shorten helpers');
    assert.ok(roles.component, 'Header or Footer by name');
    assert.ok(!p.groups.some((g) => g.roots.includes('Page')), 'the default export stays');
    for (const g of p.groups) assert.ok(g.lines >= 40, `${g.file} has ${g.lines} lines`);
    assert.equal(p.folder, p.groups.length >= 3);
    if (p.folder) assert.match(p.groups[0].file, /\/Page\/[^/]+$/);
    assert.ok(p.residual < p.lines);
});

test('plan: under 40 movable lines is not a file; a coupled test and an unsplittable anchor skip', () => {
    const small = sandbox({ 'src/Small.tsx': `export const A = 1;\nexport default function Small() {\n${pad('s', 420)}\n    return null;\n}\n` });
    const p = planFile(small.at('src/Small.tsx'), { limit: 400 });
    assert.match(p.skip, /nothing can leave|anchor/);
    const coupled = sandbox({
        'src/Page.tsx': BIG,
        'src/Page.test.js': "import fs from 'node:fs';\nit('x', () => { fs.readFileSync(new URL('./Page.tsx', import.meta.url), 'utf8'); });\n",
    });
    assert.match(planFile(coupled.at('src/Page.tsx'), { limit: 150 }).skip, /coupled/);
});

test('equivalence: a move is the same program, an edit is not', () => {
    const old = "import a from 'a';\nconst X = 1;\nfunction f() { return X + 1; }\nexport function g() { return f(); }\n";
    const moved = [
        ['/n/old.ts', "import a from 'a';\nimport { X, f } from './new';\nexport function g() { return f(); }\nexport { X };\n"],
        ['/n/new.ts', "export const X = 1;\nexport function f() { return X + 1; }\n"],
    ];
    assert.equal(equivalence('/n/old.ts', old, moved).ok, true);
    const edited = [moved[0], ['/n/new.ts', "export const X = 1;\nexport function f() { return X + 2; }\n"]];
    const bad = equivalence('/n/old.ts', old, edited);
    assert.equal(bad.ok, false);
    assert.ok(bad.missing.length && bad.extra.length);
    const dropped = equivalence('/n/old.ts', old, [moved[0], ['/n/new.ts', 'export const X = 1;\n']]);
    assert.equal(dropped.ok, false);
    assert.ok(statementsOf('/n/c.tsx', 'export const A = () => <b />;\n').length === 1, 'JSX and types go through esbuild');
});

test('run: splits a file in a git sandbox, keeps the program, and reverts a split that fails a gate', async () => {
    const sb = sandbox({
        'src/Page.tsx': BIG,
        'src/index.ts': "export { default } from './Page';\nexport { TABLE } from './Page';\n",
        'src/use.ts': "import { TABLE } from './Page';\nexport const t = TABLE.k1;\n",
    });
    const g = (...a) => spawnSync('git', a, { cwd: sb.root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const before = sb.read('src/Page.tsx');
    const report = await run([sb.at('src/Page.tsx')], { limit: 150, repo: sb.root, pkgRel: 'agent-hub', scc: false, typecheck: false, tests: false, budget: false, log: () => {} });
    assert.equal(report.reverted.length, 0, JSON.stringify(report.reverted));
    assert.equal(report.done.length, 1);
    const entry = report.done[0];
    assert.ok(entry.after < entry.before);
    const files = fs.readdirSync(sb.at('src'), { recursive: true }).map(String);
    assert.ok(files.length > 4, files.join(','));
    // importers of the moved export now read it from where it lives
    assert.doesNotMatch(sb.read('src/use.ts'), /from '\.\/Page'/);
    assert.notEqual(sb.read(entry.folder ? 'src/Page/index.tsx' : 'src/Page.tsx'), before);
    // the whole program is still one: every statement of the old file runs somewhere
    const all = files.filter((f) => /\.tsx?$/.test(f) && !/index\.ts$/.test(f) && !/use\.ts$/.test(f)).map((f) => [sb.at(`src/${f}`), sb.read(`src/${f}`)]);
    assert.equal(equivalence(sb.at('src/Page.tsx'), before, all).ok, true);
    assert.equal(g('status', '--porcelain', '--', 'agent-hub').stdout.trim().split('\n').every((l) => /^[AMR] /.test(l)), true, 'accepted work is staged');
});

test('run: a split that fails a gate is reverted, nothing is left behind', async () => {
    const sb = sandbox({ 'src/Page.tsx': BIG });
    const g = (...a) => spawnSync('git', a, { cwd: sb.root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const before = sb.read('src/Page.tsx');
    const report = await run([sb.at('src/Page.tsx')], { limit: 150, repo: sb.root, pkgRel: 'agent-hub', scc: false, typecheck: false, tests: false, budget: false, log: () => {}, check: () => 'forced by the test' });
    assert.deepEqual(report.reverted.map((r) => r.reason), ['forced by the test']);
    assert.equal(report.done.length, 0);
    assert.equal(sb.read('src/Page.tsx'), before);
    assert.equal(g('status', '--porcelain').stdout.trim(), '', 'no new files, no edits');
});
