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

test('authfetch-effect needs both halves, and leaves tests alone', () => {
    const dir = sandbox({
        files: {
            'Hand.jsx': 'useEffect(() => { authFetch(url).then(setX); }, []);\n',
            'QueryOnly.jsx': 'const q = useQuery({ queryFn: () => authFetch(url) });\n',
            'EffectOnly.jsx': 'useEffect(() => { document.title = t; }, [t]);\n',
            'Hand.test.jsx': 'useEffect(() => {}); vi.mock("authFetch");\nauthFetch.mockResolvedValue(1);\n',
        },
    });
    assert.strictEqual(run(dir, 'authfetch-effect').code, 0);
    assert.strictEqual(budgetOf(dir, 'authfetch-effect'), 1);
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
