/**
 * The ratchet is a gate, so the first thing worth testing is that it REFUSES:
 * a tree with more untranslated strings than the budget, and an --update that
 * would raise it.
 *
 * The second thing is every EXEMPTION. Each rule in the header of
 * i18n-ratchet.mjs claims that some shape is not user-facing, and a claim that
 * is only asserted over the real tree is untestable: a scanner that finds
 * nothing satisfies "the tree is clean" exactly as well as one that works. So
 * each rule gets a fixture pair — the shape it exempts, and a shape one
 * character away from it that must still be counted.
 *
 * Sandbox style is the one scripts/ts-ratchet.test.mjs uses: a throwaway repo
 * under os.tmpdir(), the real script copied in, a src/ tree built from
 * whatever files the case asks for.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'i18n-ratchet.mjs');

function sandbox({ files = {}, budget = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/i18n-ratchet.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg', 'src'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, 'pkg', 'src', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    if (budget !== null) {
        fs.writeFileSync(path.join(dir, 'pkg', '.i18n-ratchet.json'), JSON.stringify({ strings: budget }));
    }
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/i18n-ratchet.mjs'), 'pkg', ...extra], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.i18n-ratchet.json'), 'utf8')).strings;

/** The texts the ratchet counted, from a sandbox built out of `files`. */
const SITE_RX = /^src\/\S+:\d+ \[[a-z-]+\] (".*")$/;
function counted(files) {
    const r = run(sandbox({ files, budget: 9999 }), ['--list']);
    assert.strictEqual(r.code, 0, r.stderr);
    return r.stdout.split('\n').map(l => SITE_RX.exec(l)).filter(Boolean).map(m => JSON.parse(m[1]));
}

const component = (body) => `export default function C() {\n    return (\n${body}\n    );\n}\n`;

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

test('more untranslated strings than the budget fails', () => {
    const r = run(sandbox({ files: { 'A.jsx': component('<p>One</p>') }, budget: 0 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1 untranslated user-facing literals under src/);
    assert.match(r.stderr, /budget is 0/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ files: { 'A.jsx': component('<p>One</p>') }, budget: 1 })).code, 0);
    const r = run(sandbox({ files: { 'A.jsx': component('<p>{x}</p>') }, budget: 1 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 1/);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ files: { 'A.jsx': component('<p>One</p>') }, budget: 4 });
    assert.strictEqual(run(lower, ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 1);

    const higher = sandbox({ files: { 'A.jsx': component('<p>One</p><p>Two</p>') }, budget: 1 });
    assert.strictEqual(run(higher, ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 1, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ files: { 'A.jsx': component('<p>One</p><p>Two</p>') } });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 2);
});

test('--list names the sites, with file, line and kind', () => {
    const r = run(sandbox({ files: { 'A.jsx': component('<input placeholder="Your name" />') }, budget: 9 }), ['--list']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /src\/A\.jsx:3 \[placeholder\] "Your name"/);
});

test('a package without a src directory is a usage error, not a pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/i18n-ratchet.mjs'));
    const r = run(dir);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /not found/);
});

test('a file the scanner cannot read to the end fails the run instead of counting zero', () => {
    // The one failure mode a ratchet must not have is the silent one: a
    // half-read file simply lowers the number, and the next real string slips
    // in under the slack it left.
    const r = run(sandbox({ files: { 'Broken.jsx': 'export default () => <div>Hello' }, budget: 9 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /could not read to the end/);
    assert.match(r.stderr, /Broken\.jsx/);
});

// ---------------------------------------------------------------------------
// Rule 1 — JSX is walked, not matched.
// ---------------------------------------------------------------------------

test('a comparison that looks like a text node is not one', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<div>{rows.length > 0 && <Row />}<p>Real copy</p></div>'),
    }), ['Real copy']);
});

test('a comment between the bracket and the element does not hide the element', () => {
    // Copied from AppStudio/runtime/components/AppFileGallery.jsx, where an
    // expression-position check that read BACKWARDS over whitespace landed on
    // the full stop ending the `//` line, took the `<img` for a less-than, and
    // left the rest of that file unscanned.
    assert.deepStrictEqual(counted({
        'A.jsx': component([
            '<div>{show ? (',
            '    // Big enough to tell one thing from another.',
            '    <img src={a} alt="Thumbnail" />',
            ') : null}</div>',
        ].join('\n')),
    }), ['Thumbnail']);
});

test('a regex holding a quote inside a template interpolation does not swallow the file', () => {
    // AppStudio/bi/FilterRowsEditor.jsx, line for line: a skipper that knew
    // only strings and braces lost the closing backtick here and read the
    // remaining 200 lines of the file as template text — silently.
    assert.deepStrictEqual(counted({
        'A.jsx': [
            'export function parse(src) {',
            '    return JSON.parse(`"${src.slice(1, -1).replace(/"/g, \'\\\\"\')}"`);',
            '}',
            'export default function C() {',
            '    return <button title="Retry">Go</button>;',
            '}',
        ].join('\n'),
    }), ['Retry', 'Go']);
});

test('a JSDoc usage example is a comment, not copy', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': `/**\n * <Modal title="Edit">body</Modal>\n */\n${component('<p>Real copy</p>')}`,
    }), ['Real copy']);
});

// ---------------------------------------------------------------------------
// Rules 2 and 3 — what is a literal, and which attributes are read.
// ---------------------------------------------------------------------------

test('an attribute whose value is an expression is the other guard\'s business', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<input placeholder={t(\'a.b\', \'Your name\')} title={label} />'),
    }), []);
});

test('the machine-facing attributes are not read', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<div className="flex gap-2" data-testid="row card" id="main panel" key="new chat" href="https://example.com/a b" value="created at" />'),
    }), []);
});

test('title and placeholder on a component count, like on an element', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<Modal title="Edit settings"><Field placeholder="Your name" /></Modal>'),
    }), ['Edit settings', 'Your name']);
});

// ---------------------------------------------------------------------------
// Rules 4 and 5 — the two attribute exemptions.
// ---------------------------------------------------------------------------

test('a title on an <svg> is not a tooltip, a title on a button is', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<span><svg title="Bee logo" viewBox="0 0 8 8" /><button title="Close panel" /></span>'),
    }), ['Close panel']);
});

test('alt="" is deliberate, any other alt is copy', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<span><img src={a} alt="" /><img src={b} alt="Current wallpaper" /></span>'),
    }), ['Current wallpaper']);
});

// ---------------------------------------------------------------------------
// Rules 6 and 7 — what is not a sentence.
// ---------------------------------------------------------------------------

test('punctuation, numbers, symbols and emoji are not strings to translate', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<div><span>—</span><span>·</span><span>→</span><span>✕</span><span>🐝</span><span>0</span><span>12.5</span><span>x</span></div>'),
    }), []);
});

test('an emoji with a word beside it is still copy', () => {
    assert.deepStrictEqual(counted({ 'A.jsx': component('<p>💡 Tip</p>') }), ['💡 Tip']);
});

test('a machine token is not copy, the same word in a sentence is', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component([
            '<div>',
            '    <span>created_at</span>',
            '    <span>application/json</span>',
            '    <span>https://example.com/docs</span>',
            '    <span>#0ea5e9</span>',
            '    <span>v1.2.3</span>',
            '    <span>Sorted by created_at</span>',
            '</div>',
        ].join('\n')),
    }), ['Sorted by created_at']);
});

test('an html entity is read as what it renders', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<div><span>&nbsp;</span><span>&middot;</span><span>Users &amp; groups</span></div>'),
    }), ['Users &amp; groups']);
});

// ---------------------------------------------------------------------------
// Rule 8 — children meant to be read literally.
// ---------------------------------------------------------------------------

test('<code>, <pre>, <kbd> and <samp> hold literals; a styled span does not exempt itself', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component([
            '<div>',
            '    <code>npm run dev</code>',
            '    <pre>GET /api/health</pre>',
            '    <kbd>Ctrl Shift P</kbd>',
            '    <samp>exit code 1</samp>',
            '    <span className="font-mono">Run this first</span>',
            '</div>',
        ].join('\n')),
    }), ['Run this first']);
});

test('a <title> child is read, unlike the title attribute', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': component('<svg viewBox="0 0 8 8"><title>Bee logo</title></svg>'),
    }), ['Bee logo']);
});

// ---------------------------------------------------------------------------
// Rule 9 — interpolation.
// ---------------------------------------------------------------------------

test('an interpolation-only node is not a string, the words around it are', () => {
    // `{name}` splits the sentence into two text nodes, and both are reported.
    // That is the honest reading: JSX really does render two nodes there, and
    // a sentence broken around an interpolation is precisely the one that
    // needs a key with a placeholder rather than two half-keys.
    assert.deepStrictEqual(counted({
        'A.jsx': component('<div><span>{count}</span><span>Hello {name}, welcome back</span></div>'),
    }), ['Hello', ', welcome back']);
});

// ---------------------------------------------------------------------------
// Rules 10, 11 and 12 — scope.
// ---------------------------------------------------------------------------

test('marketing/ is listed but does not move the number', () => {
    const dir = sandbox({
        files: { 'marketing/Hero.jsx': component('<h1>Privacy-first AI workspace</h1>'), 'A.jsx': component('<p>App copy</p>') },
        budget: 1,
    });
    const r = run(dir, ['--list']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Privacy-first AI workspace"\s+\(marketing — not budgeted\)/);
    assert.match(r.stdout, /plus 1 in marketing, not budgeted/);
    assert.match(r.stdout, /1 untranslated literals under src/);
});

test('demo/, test/ and i18n/ are not scanned at all', () => {
    assert.deepStrictEqual(counted({
        'demo/Host.jsx': component('<p>Invented customer</p>'),
        'test/render.tsx': component('<p>Test harness</p>'),
        'i18n/Panel.jsx': component('<p>Dictionary chrome</p>'),
        'A.jsx': component('<p>App copy</p>'),
    }), ['App copy']);
});

test('a test file next to its source is not scanned', () => {
    assert.deepStrictEqual(counted({
        'A.test.jsx': component('<p>Assertion fixture</p>'),
        'A.jsx': component('<p>App copy</p>'),
    }), ['App copy']);
});

test('markup built as a template literal is a string, not JSX', () => {
    assert.deepStrictEqual(counted({
        'A.jsx': 'export const html = `<img src="${u}" alt="Diagram" />`;\n' + component('<p>App copy</p>'),
    }), ['App copy']);
});

test('the skipped and unbudgeted trees still exist in agent-hub/src', () => {
    // Every prefix in the script is a claim about the tree, and a claim that
    // has stopped being true silently exempts whatever moved in behind it —
    // the failure the rot checks in i18nGuard.test.js exist to prevent. This
    // one reads the lists out of the script rather than restating them, so a
    // renamed directory fails here instead of quietly widening the exemption.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const listed = (name) => {
        const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src);
        assert.ok(m, `${name} is no longer a plain array literal — this test cannot read it any more`);
        return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    };
    const prefixes = [...listed('OUT_OF_SCOPE'), ...listed('UNBUDGETED')];
    assert.ok(prefixes.length >= 4, 'expected i18n/, test/, demo/ and marketing/');
    const gone = prefixes.filter(p => !fs.existsSync(path.join(HERE, '..', 'agent-hub/src', p)));
    assert.deepStrictEqual(gone, [], 'these trees are gone — drop them from the script instead of leaving a dead exemption');
});
