import nodeTest from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Like rq-codemod.test.mjs: skipped where agent-hub's typescript is not installed.
let hasTs = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); hasTs = true; } catch { /* not installed */ }
const test = hasTs ? nodeTest : nodeTest.skip;
const { main, isApiShaped } = hasTs ? await import('./api-relocate.mjs') : {};
const { loadTs } = hasTs ? await import('./lib/ts-service.mjs') : {};

function sandbox(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relocate-'));
    const all = {
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, allowJs: true, baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*'] }),
        'src/utils/helpers.ts': 'export const authFetch = (url: string, init?: object) => fetch(url, init);\nexport const API_BASE = "";\n',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return { root, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), has: (rel) => fs.existsSync(path.join(root, rel)) };
}

const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('isApiShaped: a plain fetch function yes, a component or a hook no', () => {
    const ts = loadTs();
    assert.equal(isApiShaped(ts, '/x/a.ts', 'export async function load() { return authFetch("/a"); }'), true);
    assert.equal(isApiShaped(ts, '/x/a.ts', 'export function useLoad() { const [a] = useState(); authFetch("/a"); }'), false);
    assert.equal(isApiShaped(ts, '/x/a.ts', 'export const Panel = () => { authFetch("/a"); }'), false);
    assert.equal(isApiShaped(ts, '/x/a.ts', 'authFetch("/a");'), false);
    assert.equal(isApiShaped(ts, '/x/a.ts', 'export const x = 1;'), false);
});

test('moves an api module, rewrites importers and vi.mock paths, moves its test', () => {
    const sb = sandbox({
        'src/pages/notes/notesApi.ts': 'import { authFetch, API_BASE } from "../../utils/helpers";\nexport async function loadNotes() { return authFetch(`${API_BASE}/api/notes`); }\n',
        'src/pages/notes/notesApi.test.ts': 'import { loadNotes } from "./notesApi";\nvi.mock("./notesApi", () => ({}));\nexport { loadNotes };\n',
        'src/pages/notes/NotesPage.tsx': 'import { loadNotes } from "./notesApi";\nexport default function NotesPage() { void loadNotes; return <p />; }\n',
        'src/components/Other.tsx': 'import { loadNotes } from "@/pages/notes/notesApi";\nexport const Other = () => { void loadNotes; return null; };\n',
        'src/components/Other.test.tsx': 'vi.mock("@/pages/notes/notesApi");\nvi.mock("../pages/notes/notesApi", async () => ({ ...(await vi.importActual("../pages/notes/notesApi")) }));\n',
    });
    const out = quiet(() => main(['--auto', '--package', sb.root]));
    assert.equal(out.refused.length, 0);
    assert.ok(sb.has('src/api/notesApi.ts'));
    assert.ok(sb.has('src/api/notesApi.test.ts'));
    assert.ok(!sb.has('src/pages/notes/notesApi.ts'));
    assert.match(sb.read('src/api/notesApi.ts'), /from ['"]\.\.\/utils\/helpers['"]/);
    assert.match(sb.read('src/pages/notes/NotesPage.tsx'), /from ['"]@?[./]*\/?(?:\.\.\/\.\.\/)?(?:src\/)?api\/notesApi['"]|api\/notesApi/);
    assert.match(sb.read('src/components/Other.tsx'), /api\/notesApi/);
    assert.doesNotMatch(sb.read('src/components/Other.tsx'), /pages\/notes/);
    const mockTest = sb.read('src/components/Other.test.tsx');
    assert.doesNotMatch(mockTest, /pages\/notes/);
    assert.match(mockTest, /vi\.mock\("@\/api\/notesApi"\)/);
    assert.match(mockTest, /vi\.mock\("\.\.\/api\/notesApi"/);
    assert.match(mockTest, /vi\.importActual\("\.\.\/api\/notesApi"\)/);
    assert.match(sb.read('src/api/notesApi.test.ts'), /vi\.mock\("\.\/notesApi"/);
});

test('a name taken in api/ takes the feature directory as a prefix; --dry writes nothing', () => {
    const sb = sandbox({
        'src/api/http.ts': 'export const x = 1;\n',
        'src/pages/billing/http.ts': 'import { authFetch } from "../../utils/helpers";\nexport const get = () => authFetch("/b");\n',
    });
    const out = quiet(() => main(['--auto', '--dry', '--package', sb.root]));
    assert.deepEqual(out.moved.map((m) => m.to), ['src/api/billingHttp.ts']);
    assert.ok(sb.has('src/pages/billing/http.ts'));
    assert.ok(!sb.has('src/api/billingHttp.ts'));
});

test('layer rule: a type file moves down with the module, a component dependency refuses it', () => {
    const sb = sandbox({
        'src/pages/a/aApi.ts': 'import { authFetch } from "../../utils/helpers";\nimport type { Row } from "./a.types";\nexport const rows = (): Promise<Row[]> => authFetch("/a").then((r) => r.json());\n',
        'src/pages/a/a.types.ts': 'export interface Row { id: string }\n',
        'src/pages/b/bApi.ts': 'import { authFetch } from "../../utils/helpers";\nimport { Chip } from "./Chip";\nexport const b = () => { void Chip; return authFetch("/b"); };\n',
        'src/pages/b/Chip.tsx': 'export const Chip = () => <i />;\n',
    });
    const out = quiet(() => main(['--auto', '--package', sb.root]));
    assert.deepEqual(out.moved.map((m) => m.to).sort(), ['src/api/a.types.ts', 'src/api/aApi.ts']);
    assert.equal(out.refused.length, 1);
    assert.match(out.refused[0].reason, /api\/ may not import pages\//);
    assert.ok(sb.has('src/pages/b/bApi.ts'));
    assert.match(sb.read('src/api/aApi.ts'), /from ["']\.\/a\.types["']/);
});

test('.file-budget.json keys follow a moved file', () => {
    const sb = sandbox({
        'src/pages/c/cApi.ts': 'import { authFetch } from "../../utils/helpers";\nexport const c = () => authFetch("/c");\n',
        '.file-budget.json': JSON.stringify({ files: { 'src/a.ts': 500, 'src/pages/c/cApi.ts': 450, 'src/z.ts': 410 } }, null, 4) + '\n',
    });
    quiet(() => main(['--auto', '--package', sb.root]));
    assert.deepEqual(Object.keys(JSON.parse(sb.read('.file-budget.json')).files), ['src/a.ts', 'src/api/cApi.ts', 'src/z.ts']);
});
