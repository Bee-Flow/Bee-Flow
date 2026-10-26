/**
 * Two things are worth testing here. The ratchet is a gate, so it has to
 * REFUSE: a tree over its budget, and an --update that would raise it. And
 * each metric is a pattern, so it has to DISCRIMINATE: the fire-event metric
 * exists to leave keyDown and drag alone, and a pattern that counted them
 * would set a floor nobody can reach.
 *
 * Sandbox style is the one scripts/ts-ratchet.test.mjs uses: a throwaway repo
 * under os.tmpdir(), the real script copied in, a src/ tree built from
 * whatever path → contents the case asks for.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'count-ratchet.mjs');

function sandbox({ files = {}, metric = 'inline-style', budget = null, pkg = 'pkg', src = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/count-ratchet.mjs'));
    const root = src ? path.join(dir, pkg, 'src') : path.join(dir, pkg);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    if (budget !== null) {
        fs.writeFileSync(path.join(dir, pkg, `.${metric}-ratchet.json`), JSON.stringify({ count: budget }));
    }
    return dir;
}

function run(dir, metric = 'inline-style', extra = [], pkg = 'pkg') {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/count-ratchet.mjs'), metric, pkg, ...extra], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir, metric = 'inline-style', pkg = 'pkg') =>
    JSON.parse(fs.readFileSync(path.join(dir, pkg, `.${metric}-ratchet.json`), 'utf8')).count;

const TWO_STYLES = `export const A = () => <div style={{ color: 'var(--x)' }}><span style={ { margin: 0 } } /></div>;\n`;

test('more inline styles than the budget fails, and says what to do instead', () => {
    const r = run(sandbox({ files: { 'a.jsx': TWO_STYLES }, budget: 1 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /2 inline style objects under src, budget is 1/);
    assert.match(r.stderr, /text-\[var\(--x\)\]/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ files: { 'a.jsx': TWO_STYLES }, budget: 2 })).code, 0);
    const r = run(sandbox({ files: { 'a.jsx': TWO_STYLES }, budget: 5 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 5/);
});

test('a style held in a variable is not an inline object', () => {
    const dir = sandbox({
        files: {
            'a.tsx': 'const s = { color: "red" };\nexport const A = () => <div style={s} className="x" />;\n',
            'b.ts': 'export const style = { a: 1 };\n',
        },
        budget: 0,
    });
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /0 inline style objects under src, at budget/);
});

test('fire-event counts the events userEvent replaces, and leaves the low-level ones alone', () => {
    const dir = sandbox({
        metric: 'fire-event',
        files: {
            'a.test.jsx': [
                'fireEvent.click(button);',
                'fireEvent.dblClick(row);',
                "fireEvent.change(input, { target: { value: 'x' } });",
                'fireEvent.input(field);',
                'fireEvent.mouseEnter(card); fireEvent.mouseLeave(card);',
                'fireEvent.mouseOver(tip); fireEvent.mouseOut(tip);',
                // None of these has a userEvent equivalent, so none may count.
                "fireEvent.keyDown(dialog, { key: 'Escape' });",
                'fireEvent.mouseDown(handle); fireEvent.dragStart(item); fireEvent.drop(zone);',
                'fireEvent.scroll(list); fireEvent.clickOutside?.(x);',
                'fireEvent(el, new MouseEvent("click"));',
            ].join('\n'),
        },
    });
    const r = run(dir, 'fire-event');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(budgetOf(dir, 'fire-event'), 8);
});

test('build output and vendored trees cannot inflate the count', () => {
    const dir = sandbox({
        files: {
            'a.jsx': TWO_STYLES,
            'node_modules/dep/index.jsx': TWO_STYLES,
            'dist/bundle.js': TWO_STYLES,
            'coverage/x.jsx': TWO_STYLES,
        },
        budget: 2,
    });
    assert.strictEqual(run(dir).code, 0);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ files: { 'a.jsx': TWO_STYLES }, budget: 9 });
    assert.strictEqual(run(lower, 'inline-style', ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 2);

    const higher = sandbox({ files: { 'a.jsx': TWO_STYLES, 'b.jsx': TWO_STYLES }, budget: 3 });
    assert.strictEqual(run(higher, 'inline-style', ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 3, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ files: { 'a.jsx': TWO_STYLES, 'b.tsx': TWO_STYLES } });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 4);
});

test('the two metrics keep separate budget files', () => {
    const dir = sandbox({ files: { 'a.test.jsx': `${TWO_STYLES}fireEvent.click(b);\n` } });
    run(dir, 'inline-style');
    run(dir, 'fire-event');
    assert.strictEqual(budgetOf(dir, 'inline-style'), 2);
    assert.strictEqual(budgetOf(dir, 'fire-event'), 1);
});

test('--list names the files still counted, highest first', () => {
    const dir = sandbox({ files: { 'one.jsx': '<a style={{}} />', 'deep/three.jsx': `${TWO_STYLES}<b style={{}} />`, 'clean.jsx': '<a />' }, budget: 4 });
    const r = run(dir, 'inline-style', ['--list']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /3 {2}src\/deep\/three\.jsx\n\s+1 {2}src\/one\.jsx/);
    assert.doesNotMatch(r.stdout, /clean\.jsx/);
});

test('an unknown metric and a package without src are usage errors, not a pass', () => {
    const unknown = run(sandbox({ files: { 'a.jsx': TWO_STYLES } }), 'inline-styles');
    assert.strictEqual(unknown.code, 2);
    assert.match(unknown.stderr, /inline-style\|fire-event/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/count-ratchet.mjs'));
    const missing = run(dir);
    assert.strictEqual(missing.code, 2);
    assert.match(missing.stderr, /not found/);
});

// ── The file metrics: each counts a file once, however often it offends ──

const lines = (n) => `${'x;\n'.repeat(n)}`;

test('module-mock counts test files that reach into the module system, once each, and never source', () => {
    const dir = sandbox({
        files: {
            'a.test.js': "delete require.cache[require.resolve('./x')];\nrequire.cache[k] = stub; require.cache[j] = stub;\n",
            'b.test.js': "const Module = require('module');\nconst orig = Module._load;\n",
            'c.test.js': 'Module._resolveFilename = patched;\n',
            'clean.test.js': "const { makeStore } = require('./store');\nmakeStore({ db: fakeDb });\n",
            // Production code that manages the cache is not a test double.
            'loader.js': 'delete require.cache[path];\n',
        },
        src: false,
    });
    assert.strictEqual(run(dir, 'module-mock').code, 0);
    assert.strictEqual(budgetOf(dir, 'module-mock'), 3);
});

test('module-mock also counts a test that mocks through a testUtils helper, and nothing that merely names one', () => {
    const dir = sandbox({
        files: {
            'a.test.js': "const { mockModule } = require('../testUtils/moduleMock');\nmockModule(p, { x: 1 });\n",
            'b.test.js': "const restore = installResolveStub({ '../db': db });\n",
            'c.test.js': "preloadStubs(require, { '../x': {} });\n",
            'd.test.js': 'const stub = serverStubber(__dirname);\n',
            'e.test.js': 'const h = createBuilderStream(test);\n',
            // A method of the same name on something else, a longer identifier,
            // and a bare import are not calls to the helper.
            'clean1.test.js': 'harness.mockModule(p);\nconst remockModule = 1; remockModule(p);\n',
            'clean2.test.js': "const { mockModule } = require('../testUtils/moduleMock');\n",
            'clean3.test.js': "// no mockModule( here, and no require.cache either\n/* installResolveStub( */\n",
            'helper.js': 'mockModule(p, {});\n',
        },
        src: false,
    });
    assert.strictEqual(run(dir, 'module-mock').code, 0);
    assert.strictEqual(budgetOf(dir, 'module-mock'), 5);
});

test('module-mock lists every export of a testUtils helper that writes require.cache or hooks the resolver', () => {
    const utils = path.join(HERE, '..', 'server', 'testUtils');
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const listed = new Set(
        [...script.match(/MODULE_MOCK_HELPERS = \[([^\]]*)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]),
    );
    const writers = fs.readdirSync(utils).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map((f) => ({ f, text: fs.readFileSync(path.join(utils, f), 'utf8') }))
        .map(({ f, text }) => ({ f, text, code: text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n') }))
        .filter(({ code }) => /require\.cache\[|_resolveFilename\s*=|\b(?:mockModule|installResolveStub|preloadStubs)\s*\(/.test(code));
    assert.ok(writers.length >= 5, 'the scan should find the known helpers');
    const missing = [];
    for (const { f, text } of writers) {
        const exp = /module\.exports\s*=\s*\{([^}]*)\}/.exec(text);
        if (!exp) continue;
        for (const name of exp[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)) {
            if (!listed.has(name)) missing.push(`${f}: ${name}`);
        }
    }
    // Exports that are not themselves a stubbing call (parseSse, call, ...) are the
    // only legitimate gaps; each one is named here so a new helper has to be decided on.
    const NOT_STUBBERS = new Set(['builderStreamHarness.js: call', 'builderStreamHarness.js: parseSse', 'aiStepHarness.js: runStateWith']);
    assert.deepStrictEqual(missing.filter((m) => !NOT_STUBBERS.has(m)), [], 'add to MODULE_MOCK_HELPERS in scripts/count-ratchet.mjs');
});

test('authfetch-effect needs both halves, and leaves tests alone', () => {
    const dir = sandbox({
        files: {
            'Hand.jsx': 'useEffect(() => { authFetch(url).then(setX); }, []);\n',
            'QueryOnly.jsx': 'const q = useQuery({ queryFn: () => authFetch(url) });\n',
            'EffectOnly.jsx': 'useEffect(() => { document.title = t; }, [t]);\n',
            'Hand.test.jsx': 'useEffect(() => {}); vi.mock("authFetch");\nauthFetch.mockResolvedValue(1);\n',
            'Comment.jsx': '// was authFetch(url) in a useEffect\n/* authFetch useEffect */\nconst a = 1;\n',
        },
    });
    assert.strictEqual(run(dir, 'authfetch-effect').code, 0);
    assert.strictEqual(budgetOf(dir, 'authfetch-effect'), 1);
});

test('authfetch-outside-api counts files calling authFetch outside src/api, not api/, helpers or tests', () => {
    const dir = sandbox({
        files: {
            'components/Hand.jsx': 'const r = await authFetch(url);\nconst s = await authFetch(other);\n',
            'pages/Imports.jsx': "import { authFetch } from '../utils/helpers';\nexport { authFetch };\n",
            'api/client.ts': 'const res = await authFetch(url, init);\n',
            'utils/helpers.ts': 'export async function authFetch(url) { return fetch(url); }\nauthFetch(x);\n',
            'components/Hand.test.jsx': 'authFetch(url);\n',
            'components/Comment.jsx': '// replaces authFetch(url)\n/* authFetch(x) */\nconst a = 1;\n',
        },
    });
    assert.strictEqual(run(dir, 'authfetch-outside-api').code, 0);
    assert.strictEqual(budgetOf(dir, 'authfetch-outside-api'), 1);
});

test('big-file uses the package limit: 400 lines in agent-hub, 800 in server', () => {
    const hub = sandbox({ pkg: 'agent-hub', files: { 'at.jsx': lines(400), 'over.jsx': lines(401) } });
    assert.strictEqual(run(hub, 'big-file', [], 'agent-hub').code, 0);
    assert.strictEqual(budgetOf(hub, 'big-file', 'agent-hub'), 1);

    const server = sandbox({ pkg: 'server', src: false, files: { 'mid.js': lines(600), 'at.js': lines(800), 'over.js': lines(801) } });
    assert.strictEqual(run(server, 'big-file', [], 'server').code, 0);
    assert.strictEqual(budgetOf(server, 'big-file', 'server'), 1);
});

test('big-file counts a last line without a newline, which wc -l would miss', () => {
    const dir = sandbox({ pkg: 'agent-hub', files: { 'a.jsx': `${lines(400)}x;` } });
    run(dir, 'big-file', [], 'agent-hub');
    assert.strictEqual(budgetOf(dir, 'big-file', 'agent-hub'), 1, '401 lines of code are over the limit however the file ends');
});

test('big-file leaves data alone: tests, dictionaries, generated files, fixtures, content', () => {
    const dir = sandbox({
        pkg: 'server',
        src: false,
        files: {
            'x.test.js': lines(900),
            'i18n/defaults/en.js': lines(900),
            'learning/catalog.generated.js': lines(900),
            'onboarding/generated/lessons.js': lines(900),
            'appStudio/templates/appA.js': lines(900),
            'demo/fixtures/big.js': lines(900),
            'scripts/content/site.js': lines(900),
            'types/rows.d.ts': lines(900),
            // Named like the exempt folders, but code: these count.
            'routes/templates.js': lines(900),
            'routes/agents/tests.js': lines(900),
        },
    });
    run(dir, 'big-file', [], 'server');
    assert.strictEqual(budgetOf(dir, 'big-file', 'server'), 2);
});

test('dutch-comment reads comments only, and needs two Dutch words on one line', () => {
    const dir = sandbox({
        files: {
            'nl.js': '// Dit is de reden waarom het zo werkt\nconst a = 1;\n',
            'nl-block.js': '/**\n * Een testbeurt schrijft onder zijn eigen bron.\n */\n',
            'en.js': '// Here the value is read once, then cached\n',
            // A Dutch user-facing string is i18n's business, not the comment policy's.
            'string.js': "const msg = 'Dit is niet goed';\n",
            // One stray word is a name or an English word, not a Dutch sentence.
            'one-word.js': '// Dan asked for this in the review\n',
            // The dictionaries' notes are translator notes: not counted.
            'i18n/defaults/nl-notes.js': '// Dit is de reden waarom het zo werkt\n',
        },
    });
    assert.strictEqual(run(dir, 'dutch-comment').code, 0);
    assert.strictEqual(budgetOf(dir, 'dutch-comment'), 2);
});

test('a package without src is scanned from its own directory, and says so', () => {
    const dir = sandbox({ src: false, files: { 'a.test.js': 'require.cache[k] = 1;\n', 'deep/b.test.js': 'require.cache[k] = 1;\n' }, metric: 'module-mock', budget: 1 });
    const r = run(dir, 'module-mock');
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /2 test files mocking through the module system in pkg, budget is 1/);
});

test('line-ref counts comments that point at a line number, and not names that look like one', () => {
    const dir = sandbox({
        files: {
            'refs.js': [
                '// the other gated routers use at L353+; see below',
                '// down (same pattern as /api/compliance on L304).',
                '// destructured further down (L340), so we lazy-require it here.',
                '//   see session-skill setup at ~L1081-1238',
                '// mirror of the pass in [directChat.js#L3922](server/routes/ai/directChat.js#L3922).',
                "const url = 'https://x/y.js#L12'; // a string, but also on a code line: not a comment line",
            ].join('\n'),
            'names.js': [
                '// Hoort in stage L16 te veranderen.',
                '// Level L2 cache; the L100 model series',
                '// see line 4 of the spec (prose, no L-number)',
            ].join('\n'),
        },
    });
    assert.strictEqual(run(dir, 'line-ref').code, 0);
    assert.strictEqual(budgetOf(dir, 'line-ref'), 5);
});

test('error-echo counts handed-back error messages in source, and leaves other error fields and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.js': "res.status(400).json({ error: e.message });\nres.status(422).json({ error: err.message });\n",
            'b.js': "res.status(400).json({ error: 'Bad input' });\nres.json({ error: e.message, code: 'x' });\n",
            'a.test.js': "res.status(400).json({ error: e.message });\n",
        },
    });
    assert.strictEqual(run(dir, 'error-echo').code, 0);
    assert.strictEqual(budgetOf(dir, 'error-echo'), 2);
});

test('explicit-any counts any annotations, casts and type arguments in TypeScript source, not words containing any or tests', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.ts': 'const x: any = 1;\nconst y = z as any;\nconst m = new Map<any>();\nconst company = 1;\n',
            'b.tsx': 'function f(a: anyThing) { return a; }\n',
            'c.js': 'const x = y; // : any in a comment of js\n',
            'a.test.ts': 'const x: any = 1;\n',
        },
    });
    assert.strictEqual(run(dir, 'explicit-any').code, 0);
    assert.strictEqual(budgetOf(dir, 'explicit-any'), 3);
});

test('jsdoc-loose-type counts JSDoc types that are exactly any, *, Function, Object or object, not tests or compound types', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.js': '/**\n * @param {any} a\n * @param {*} b\n * @param {Object} c\n * @param {object} d\n * @param {Function} e\n * @param {string} f\n * @param {Array<any>} g\n */\n',
            'b.js': '/** @returns {any} */\n',
            'a.test.js': '/** @param {any} a */\n',
        },
    });
    assert.strictEqual(run(dir, 'jsdoc-loose-type').code, 0);
    assert.strictEqual(budgetOf(dir, 'jsdoc-loose-type'), 6);
});

test('eslint-disable counts disable directives in source (block, next-line and line), not mentions or tests', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.ts': '// eslint-disable-next-line no-console\nconsole.log(1);\nfoo(); // eslint-disable-line no-undef\n/* eslint-disable react/no-danger */\n',
            'b.js': 'const s = "eslint-disable in a string";\n// we never eslint-disable here\n',
            'a.test.ts': '// eslint-disable-next-line no-console\n',
            'notes.md': '// eslint-disable\n',
        },
    });
    assert.strictEqual(run(dir, 'eslint-disable').code, 0);
    assert.strictEqual(budgetOf(dir, 'eslint-disable'), 3);
});

test('as-unknown-as counts double casts in source and leaves single casts and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.ts': 'const x = y as unknown as Foo;\nconst z = y as unknown;\n',
            'a.test.ts': 'const x = y as unknown as Foo;\n',
        },
    });
    assert.strictEqual(run(dir, 'as-unknown-as').code, 0);
    assert.strictEqual(budgetOf(dir, 'as-unknown-as'), 1);
});

test('log-user-content counts log calls carrying a prompt, file name, e-mail or message text, and leaves lengths and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'b.js': 'log.info(`parsing ${log.nameForLog(file.originalname)}`);\n',
            'a.js': 'log.info(`gen for ${userId}: "${prompt.substring(0, 80)}"`);\nlog.warn(\'skipped\', file.originalname);\nlog.info(`prompt ${prompt.length} chars`);\nlog.debug(\'x\', { id });\n',
            'a.test.js': 'log.info(`${prompt}`);\n',
        },
    });
    assert.strictEqual(run(dir, 'log-user-content').code, 0);
    assert.strictEqual(budgetOf(dir, 'log-user-content'), 2);
});

test('--list on a package without a budget lists and writes no budget file', () => {
    const dir = sandbox({ src: false, files: { 'a.js': "res.status(500).json({ error: 'x' });\n" } });
    assert.strictEqual(run(dir, 'status-5xx', ['--list']).code, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'pkg', '.status-5xx-ratchet.json')), false);
});

test('status-5xx counts literal 5xx statuses in source, and leaves 4xx, computed statuses and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'a.js': "res.status(500).json({ error: 'x' });\nreturn res.status( 502 ).json(r);\nres.status(404).json({});\n",
            'b.js': 'res.status(code).json({});\nres.status(200).end();\n',
            'a.test.js': 'res.status(500).json({});\n',
        },
    });
    assert.strictEqual(run(dir, 'status-5xx').code, 0);
    assert.strictEqual(budgetOf(dir, 'status-5xx'), 2);
});

test('import-zones counts files importing against the layer direction, once each, and leaves the allowed direction alone', () => {
    const dir = sandbox({
        pkg: 'agent-hub',
        files: {
            // Upward: each counts once, however many wrong imports it has.
            'api/queries/a.ts': "import { X } from '../../components/x/X';\nimport { P } from '../../pages/P';\n",
            'hooks/useB.ts': "import { Ctx } from '@/components/licensing/Ctx';\n",
            'hooks/deep/c.ts': "export { fmt } from '../../pages/settings/format';\n",
            'components/admin/d.tsx': "const Page = lazy(() => import('../../pages/DocumentsPage'));\n",
            'components/e.js': "const p = require('../pages/p');\n",
            // Allowed: downward, sideways, packages, and names that only look like a zone.
            'components/ok.tsx': "import { q } from '../api/queries/q';\nimport { useX } from '@/hooks/useX';\nimport { C } from './other/C';\nimport { Q } from '@tanstack/react-query';\n",
            'hooks/ok.ts': "import { api } from '../api/client';\nimport { pagesOf } from '../utils/pages';\nimport x from 'components';\n",
            'pages/P.jsx': "import { X } from '../components/x/X';\n",
            'utils/u.js': "import { P } from '../pages/P';\n",
            'api/comment.ts': "// see components/x/X for the shape; not an import\n",
            // Tests may render a page: not a dependency of the product.
            'hooks/useB.test.ts': "import P from '../pages/P';\n",
            'components/f.test.tsx': "import P from '@/pages/P';\n",
        },
    });
    run(dir, 'import-zones', [], 'agent-hub'); // records the first budget; --list alone only reads
    const r = run(dir, 'import-zones', ['--list'], 'agent-hub');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(budgetOf(dir, 'import-zones', 'agent-hub'), 5);
    assert.doesNotMatch(r.stdout, /ok\.tsx?|pages\/P|utils\/u|comment|\.test\./);
});

test('import-zones fails a new upward import over the budget', () => {
    const dir = sandbox({
        pkg: 'agent-hub',
        metric: 'import-zones',
        budget: 0,
        files: { 'hooks/useNew.ts': "import { Panel } from '../components/Panel';\n" },
    });
    const r = run(dir, 'import-zones', [], 'agent-hub');
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 files importing against the layer direction .* budget is 0/);
    assert.match(r.stderr, /move the shared piece down/);
});

test('unchecked-mutation counts non-GET authFetch calls nobody checks, and leaves checked, returned and GET calls alone', () => {
    const unchecked = [
        "export async function del(id) {\n    await authFetch(`/api/x/${id}`, { method: 'DELETE' });\n    setList((l) => l.filter((x) => x.id !== id));\n}\n",
        "export function bg() {\n    authFetch('/api/ping', { method: 'POST' }).catch(() => {});\n}\n",
        "export async function save() {\n    const res = await authFetch('/api/x', { method: 'PUT', body: '{}' });\n    const data = await res.json();\n    console.error(data);\n}\n",
    ].join('');
    const checked = [
        // .ok read on the name
        "export async function a() {\n    const res = await authFetch('/api/a', { method: 'POST' });\n    if (!res.ok) throw new Error('x');\n}\n",
        // typed name, .status read
        "export async function b() {\n    const res: Response = await authFetch('/api/b', { method: 'PATCH' });\n    return res.status;\n}\n",
        // returned: the caller owns the check
        "export const c = () => authFetch('/api/c', { method: 'DELETE' });\nexport function d() {\n    return authFetch('/api/d', { method: 'POST' });\n}\n",
        // handed straight to a reader
        "export async function e() {\n    await readJson(await authFetch('/api/e', { method: 'DELETE' }));\n}\n",
        // ternary assignment
        "export async function f(x) {\n    const res = x\n        ? await authFetch('/api/f', { method: 'DELETE' })\n        : await authFetch('/api/f', { method: 'POST' });\n    if (!res.ok) return;\n}\n",
        // Promise.all destructuring
        "export async function g() {\n    const [r1, r2] = await Promise.all([\n        authFetch('/api/g1', { method: 'POST' }),\n        authFetch('/api/g2', { method: 'POST' }),\n    ]);\n    return r1.ok && r2.ok;\n}\n",
        // .then that reads .ok
        "export function h() {\n    authFetch('/api/h', { method: 'POST' }).then((r) => { if (r.ok) done(); });\n}\n",
        // body branched on
        "export async function i() {\n    const res = await authFetch('/api/i', { method: 'DELETE' });\n    const data = await res.json();\n    if (data.success) done();\n}\n",
        // a GET, and the definition itself
        "export async function j() {\n    await authFetch('/api/j');\n    await authFetch('/api/j', { method: 'GET' });\n}\nexport const authFetch = async (url, options = {}) => fetch(url, options);\n",
    ].join('');
    const dir = sandbox({
        pkg: 'agent-hub',
        metric: 'unchecked-mutation',
        files: {
            'components/Bad.jsx': unchecked,
            'components/Good.tsx': checked,
            'components/Bad.test.jsx': unchecked,
        },
    });
    run(dir, 'unchecked-mutation', [], 'agent-hub'); // records the first budget; --list alone only reads
    const r = run(dir, 'unchecked-mutation', ['--list'], 'agent-hub');
    assert.strictEqual(r.code, 0);
    assert.strictEqual(budgetOf(dir, 'unchecked-mutation', 'agent-hub'), 3);
    assert.match(r.stdout, /3 {2}src\/components\/Bad\.jsx/);
    assert.doesNotMatch(r.stdout, /Good|\.test\./);
});

test('unchecked-mutation fails a new unchecked mutation over the budget and points at mutate()', () => {
    const dir = sandbox({
        pkg: 'agent-hub',
        metric: 'unchecked-mutation',
        budget: 0,
        files: { 'pages/P.jsx': "export async function p() {\n    await authFetch('/api/p', { method: 'DELETE' });\n}\n" },
    });
    const r = run(dir, 'unchecked-mutation', [], 'agent-hub');
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 non-GET authFetch calls whose Response is not checked under src, budget is 0/);
    assert.match(r.stderr, /mutate\(\) from src\/api\/mutate\.ts/);
});

test('sse-head counts hand-written event-stream heads, and leaves core/http, readers, Accept headers and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'routes/a.js': "res.writeHead(200, {\n    'Content-Type': 'text/event-stream',\n});\nres.setHeader(\"Content-Type\", 'text/event-stream');\n",
            'routes/b.js': "res.set({ 'content-type': 'text/event-stream' });\nres.type('text/event-stream');\n",
            'routes/c.js': "if (ct.includes('text/event-stream')) return;\nfetch(u, { headers: { Accept: 'text/event-stream' } });\n",
            'core/http/sseHelpers.js': "res.setHeader('Content-Type', 'text/event-stream');\n",
            'routes/a.test.js': "res.writeHead(200, { 'Content-Type': 'text/event-stream' });\n",
        },
    });
    assert.strictEqual(run(dir, 'sse-head').code, 0);
    assert.strictEqual(budgetOf(dir, 'sse-head'), 4);
});

test('inline-pglite counts test files with their own PGlite adapter, and leaves the shared helpers, plain pg.query use and non-tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'stores/a.test.js': "const pg = new PGlite();\nfunction adaptResult(res) {\n    return { rows: res.rows };\n}\n",
            'stores/b.test.js': "const pg = new PGlite();\nconst db = { run: async (s, p) => ({ rows: [], rowCount: 0 }) };\n",
            'routes/c.test.js': "const pg = new PGlite();\ndb.pool.query = (s, p) => pg.query(s, p);\n",
            'stores/d.test.js': "const pg = new PGlite();\nconst q = pgliteQuery(pg);\nconst n = (await pg.query('SELECT 1')).rows.length;\n",
            'testUtils/pglitePool.js': "const pg = new PGlite();\nfunction asPgResult(r) { return { rows: r.rows, rowCount: 0 }; }\n",
            'testUtils/x.test.js': "const pg = new PGlite();\nasync function query(s) { return pg.query(s); }\n",
            'stores/e.js': "const pg = new PGlite();\nasync function query(s) { return pg.query(s); }\n",
        },
    });
    assert.strictEqual(run(dir, 'inline-pglite').code, 0);
    assert.strictEqual(budgetOf(dir, 'inline-pglite'), 3);
});

test('local-zod-helper counts top-level schema-helper copies in routes/ and auth/, and leaves nested names, other folders and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'routes/a.js': "const worded = (message) => z.string({ error: message });\nfunction bodyOf(shape) { return shape; }\n",
            'auth/b.js': "const idList = (m) => z.array(z.string());\n",
            'routes/c.js': "const { worded, choice } = require('../core/http/schemaParts');\nfunction h() {\n    const choice = data.choices?.[0];\n}\nconst wordedText = 1;\n",
            'integrations/shared/idList.js': "function idList(value) { return value; }\n",
            'routes/a.test.js': "const worded = (message) => z.string({ error: message });\n",
        },
    });
    assert.strictEqual(run(dir, 'local-zod-helper').code, 0);
    assert.strictEqual(budgetOf(dir, 'local-zod-helper'), 3);
});

test('empty-catch counts empty and comment-only catch clauses, and leaves handled ones, promise .catch() and tests alone', () => {
    const dir = sandbox({
        files: {
            'a.js': 'try { a(); } catch {}\ntry { b(); } catch (e) { }\ntry { c(); } catch (_) { /* best effort */ }\ntry { d(); } catch {\n    // already gone\n}\n',
            'b.js': 'try { a(); } catch (e) { log.warn(e); }\ntry { b(); } catch { /* fall back */ return null; }\np.catch(() => {});\nx.catch((e) => {});\n',
            'a.test.js': 'try { a(); } catch {}\n',
        },
    });
    assert.strictEqual(run(dir, 'empty-catch').code, 0);
    assert.strictEqual(budgetOf(dir, 'empty-catch'), 4);
});

test('empty-catch fails a new swallowed error over the budget and says what to do', () => {
    const r = run(sandbox({ metric: 'empty-catch', files: { 'a.js': 'try { a(); } catch {}\n' }, budget: 0 }), 'empty-catch');
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 empty catch blocks under src, budget is 0/);
    assert.match(r.stderr, /rethrow/);
});

test('admin-id-literal counts id and username comparisons to \'admin\', and leaves role checks, comments, the helper and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'routes/a.js': "if (req.session?.user?.id === 'admin') x();\nif (userId !== 'admin') y();\nif ('admin' === user.id) z();\nif (username == \"admin\") w();\n",
            'routes/b.js': "if (user.role === 'admin') x();\n// u.id === 'admin' is the operator\nconst a = via === 'admin';\n",
            'auth/platformOperator.js': "return id === 'admin';\n",
            'routes/a.test.js': "if (u.id === 'admin') x();\n",
        },
    });
    assert.strictEqual(run(dir, 'admin-id-literal').code, 0);
    assert.strictEqual(budgetOf(dir, 'admin-id-literal'), 4);
});

test('rollback-in-store counts hand-written ROLLBACKs in stores/, and leaves savepoints, comments, other folders and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'stores/a.js': "await client.query('BEGIN');\nawait client.query(\"ROLLBACK\");\nawait client.query(ok ? 'COMMIT' : 'ROLLBACK');\nawait client.query(`ROLLBACK`).catch(() => {});\n",
            'stores/lib/b.js': "await c.query('ROLLBACK TO SAVEPOINT sp');\n// withTransaction owns COMMIT/ROLLBACK\n",
            'stores/c.js': "return db.withTransaction(async (client) => client.query('UPDATE t SET a = 1'));\n",
            'core/d.js': "await client.query('ROLLBACK');\n",
            'stores/a.test.js': "await client.query('ROLLBACK');\n",
        },
    });
    assert.strictEqual(run(dir, 'rollback-in-store').code, 0);
    assert.strictEqual(budgetOf(dir, 'rollback-in-store'), 3);
});

test('db-in-routes counts every spelling that resolves to db.js from routes/, and leaves other db modules, other folders and tests alone', () => {
    const dir = sandbox({
        src: false,
        files: {
            'routes/a.js': "const db = require('../db');\nconst { query } = require('../db.js');\n",
            'routes/admin/b.js': "const db = require('../../db');\nimport { exec } from '../../db.js';\n",
            'routes/admin/deep/c.js': "const { pool } = require('../../../db');\n",
            'routes/d.js': "const s = require('../stores/db');\nconst r = require('./db');\nconst k = require('../db/index');\nconst pkg = require('db');\n",
            'core/e.js': "const db = require('../db');\n",
            'routes/a.test.js': "const db = require('../db');\n",
        },
    });
    assert.strictEqual(run(dir, 'db-in-routes').code, 0);
    assert.strictEqual(budgetOf(dir, 'db-in-routes'), 5);
});

test('db-in-routes ignores a JSDoc type import() inside a comment', () => {
    const dir = sandbox({
        src: false,
        files: {
            'routes/a.js': "/** @type {typeof import('../db').getAll} */\nlet f;\n/**\n * @param {import('../../db').Row} r\n */\nfunction g(r) {}\nconst db = require('../db');\n",
        },
    });
    assert.strictEqual(run(dir, 'db-in-routes').code, 0);
    assert.strictEqual(budgetOf(dir, 'db-in-routes'), 1);
});

const longBody = (n) => `${'    x();\n'.repeat(n)}`;

test('long-function counts functions over 200 lines, of every shape, and not long blocks or object literals', () => {
    const dir = sandbox({
        files: {
            // 202 lines from `{` to `}`: counted.
            'a.js': `function big() {\n${longBody(200)}}\n`,
            // 200 lines: at the limit, not over it.
            'b.js': `function edge() {\n${longBody(198)}}\n`,
            'c.ts': `export const arrow = async (a: number): Promise<void> => {\n${longBody(201)}};\nclass K {\n    method(a): string {\n${longBody(201)}    }\n}\n`,
            'd.js': `if (a) {\n${longBody(250)}}\nconst o = {\n${longBody(250)}};\nfor (const x of y) {\n${longBody(250)}}\n`,
            'a.test.js': `function big() {\n${longBody(250)}}\n`,
        },
    });
    assert.strictEqual(run(dir, 'long-function').code, 0);
    assert.strictEqual(budgetOf(dir, 'long-function'), 3);
});

test('long-function is not misled by braces in strings, templates, comments or regex literals', () => {
    const noise = "    const s = '{{{'; const d = \"}\"; const t = `${'{'} } {`; // }}}\n    /* { */ const r = /[{]+/.test(s);\n";
    const dir = sandbox({
        files: {
            // A short function full of stray braces must close where it really ends,
            // so the long one after it is measured from its own `{`.
            'a.js': `function short() {\n${noise}}\nfunction long() {\n${noise}${longBody(205)}}\n`,
            // Stray braces inside a long function must not make it look shorter.
            'b.js': `function long() {\n${noise.repeat(3)}${longBody(200)}}\n`,
        },
    });
    assert.strictEqual(run(dir, 'long-function').code, 0);
    assert.strictEqual(budgetOf(dir, 'long-function'), 2);
});

test('long-function --list names the files, and --update only lowers', () => {
    const big = `function big() {\n${longBody(205)}}\n`;
    const dir = sandbox({ metric: 'long-function', files: { 'two.js': `${big}${big}`, 'one.js': big, 'small.js': 'function s() {}\n' }, budget: 9 });
    const r = run(dir, 'long-function', ['--list']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /2 {2}src\/two\.js\n\s+1 {2}src\/one\.js/);
    assert.doesNotMatch(r.stdout, /small\.js/);
    run(dir, 'long-function', ['--update']);
    assert.strictEqual(budgetOf(dir, 'long-function'), 3);
    fs.writeFileSync(path.join(dir, 'pkg/src/three.js'), big);
    run(dir, 'long-function', ['--update']);
    assert.strictEqual(budgetOf(dir, 'long-function'), 3, 'an --update must not raise the budget');
    assert.strictEqual(run(dir, 'long-function').code, 1);
});

// deep-imports: the parser module and the real root node_modules (for the TypeScript
// compiler API) are linked into the sandbox, plus an empty mirror manifest.
function deepSandbox(files, { budget = null, exclude = [], manifest = { entries: [] } } = {}) {
    const dir = sandbox({ files, pkg: 'agent-hub', metric: 'deep-imports', budget });
    fs.copyFileSync(path.join(HERE, 'deep-imports.mjs'), path.join(dir, 'scripts/deep-imports.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts/shared-mirror.manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'scripts/deep-imports.exclude.json'), JSON.stringify({ files: exclude }));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

test('deep-imports counts specifiers the alias can spell, in every import form, and nothing else', () => {
    const dir = deepSandbox({
        // Counted: two static, a dynamic import, a mock, an export-from (a file may count many).
        'components/a/b/c/Deep.tsx': "import { x } from '../../../../utils/x';\nimport y from '../../../y';\nconst Z = lazy(() => import('../../../z'));\nexport { w } from '../../../../w';\n",
        'components/a/b/c/Deep.test.tsx': "vi.mock('../../../../utils/helpers', () => ({}));\n",
        // Not counted: shallow, the alias, a package, a path that leaves src, a path that is no specifier.
        'components/a/b/c/Ok.tsx': "import a from '../../a';\nimport b from '@/b';\nimport c from 'react';\nimport s from '../../../../../server/s.js';\n// import d from '../../../d'\nconst p = '../../../../utils';\n",
        // Not counted: the file mobile runs, and a mirror source.
        'components/a/b/c/mobile.ts': "import { x } from '../../../../utils/x';\n",
        'components/a/b/c/mirrored.ts': "import { x } from '../../../../utils/x';\n",
    }, {
        exclude: ['components/a/b/c/mobile.ts'],
        manifest: { entries: [{ source: 'agent-hub/src/components/a/b/c/mirrored.ts', target: 'mobile/src/m/mirrored.ts' }] },
    });
    run(dir, 'deep-imports', [], 'agent-hub'); // records the first budget
    const r = run(dir, 'deep-imports', ['--list'], 'agent-hub');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(budgetOf(dir, 'deep-imports', 'agent-hub'), 5);
    assert.match(r.stdout, /4 {2}src\/components\/a\/b\/c\/Deep\.tsx/);
    assert.match(r.stdout, /1 {2}src\/components\/a\/b\/c\/Deep\.test\.tsx/);
    assert.doesNotMatch(r.stdout, /Ok\.tsx|mobile\.ts|mirrored\.ts/);
});

test('deep-imports fails a new deep import over the budget and names the alias', () => {
    const dir = deepSandbox({ 'components/a/b/c/New.tsx': "import { x } from '../../../utils/x';\n" }, { budget: 0 });
    const r = run(dir, 'deep-imports', [], 'agent-hub');
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 import specifiers climbing three or more levels .* budget is 0/);
    assert.match(r.stderr, /@\/<path from src>/);
});
