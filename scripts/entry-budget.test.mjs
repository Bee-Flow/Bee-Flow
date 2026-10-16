/**
 * The entry budget reads a built dist/index.html and the files it names. These
 * cases build a fake one from incompressible bytes, so gzip size is known.
 */

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'entry-budget.mjs');

const HTML = (extra = '') => `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/entry.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor.js">
<link rel="stylesheet" crossorigin href="/assets/entry.css">
<link rel="stylesheet" media="print" href="/assets/print.css">
${extra}</head><body></body></html>`;

function sandbox({ files = {}, html = HTML(), budget = null, build = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-budget-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/entry-budget.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg/dist/assets'), { recursive: true });
    if (build) fs.writeFileSync(path.join(dir, 'pkg/dist/index.html'), html);
    for (const [name, bytes] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'pkg/dist/assets', name), crypto.randomBytes(bytes));
    }
    if (budget) fs.writeFileSync(path.join(dir, 'pkg/.entry-budget.json'), JSON.stringify(budget));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/entry-budget.mjs'), 'pkg', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.entry-budget.json'), 'utf8'));
const FILES = { 'entry.js': 10_000, 'vendor.js': 20_000, 'entry.css': 8_000, 'print.css': 400_000, 'lazy.css': 400_000 };

test('an entry inside its budget passes', () => {
    const r = run(sandbox({ files: FILES, budget: { blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000 } }));
    assert.strictEqual(r.code, 0, r.stderr);
});

test('render-blocking CSS over budget fails and is named', () => {
    const r = run(sandbox({ files: FILES, budget: { blockingCssBytes: 5_000, blockingCssGzip: 9_000, entryJsGzip: 40_000 } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /blockingCssBytes .* over the budget/);
});

test('entry JS counts the module script and every modulepreload', () => {
    const r = run(sandbox({ files: FILES, budget: { blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 25_000 } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /entryJsGzip/);
});

test('a print-media stylesheet and files the entry does not name are not counted', () => {
    const r = run(sandbox({ files: FILES, budget: { blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000 } }));
    assert.strictEqual(r.code, 0, 'print.css and lazy.css are 400 kB each');
});

test('a missing budget file is an error without --update, never a pass', () => {
    const dir = sandbox({ files: FILES });
    const r = run(dir);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /--update/);
    assert.ok(!fs.existsSync(path.join(dir, 'pkg/.entry-budget.json')));
});

test('--update creates the budget at the measurement plus 3%', () => {
    const dir = sandbox({ files: FILES });
    assert.strictEqual(run(dir, ['--update']).code, 0);
    const b = budgetOf(dir);
    assert.strictEqual(b.blockingCssBytes, Math.round(8_000 * 1.03));
});

test('--update only lowers the budget', () => {
    const dir = sandbox({ files: FILES, budget: { blockingCssBytes: 99_000, blockingCssGzip: 5_000, entryJsGzip: 99_000 } });
    run(dir, ['--update']);
    const b = budgetOf(dir);
    assert.strictEqual(b.blockingCssBytes, Math.round(8_000 * 1.03), 'lowered to the measurement');
    assert.strictEqual(b.blockingCssGzip, 5_000, 'a measurement above the budget never raises it');
});

test('a reference to a file that is not in dist is an error, not a pass', () => {
    const r = run(sandbox({ files: { 'entry.js': 1_000 }, budget: { blockingCssBytes: 1, blockingCssGzip: 1, entryJsGzip: 1 } }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /does not exist/);
});

test('no build is an error, not a pass', () => {
    const r = run(sandbox({ build: false }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /run the build first/);
});

test('a stylesheet whose layer order puts utilities before base fails the gate', () => {
    const dir = sandbox({ files: FILES, budget: { blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000 } });
    fs.writeFileSync(path.join(dir, 'pkg/dist/assets/lazy.css'), '@layer theme, utilities, base, components;');
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /utilities must come last/);
});

// ── demo entries (issue #252) ──────────────────────────────────────────
// A public feature demo is its own document: the entry plus whatever its
// lazy chunk pulls in statically. The registry chunk lists the demos as
// dynamic imports; the heaviest closure beyond the entry is budgeted.

const noise = (n) => crypto.randomBytes(n).toString('base64');

function demoSandbox(budget) {
    const dir = sandbox({ files: FILES, budget });
    const assets = path.join(dir, 'pkg/dist/assets');
    fs.writeFileSync(path.join(assets, 'registry-AAA.js'),
        'const a={expectText:"x",C:()=>import(`./small-AAA.js`),F:()=>import(`./big-AAA.js`)};');
    fs.writeFileSync(path.join(assets, 'small-AAA.js'), `export default "${noise(3_000)}";`);
    fs.writeFileSync(path.join(assets, 'big-AAA.js'), `import"./shared-AAA.js";import"./vendor.js";export default "${noise(6_000)}";`);
    fs.writeFileSync(path.join(assets, 'shared-AAA.js'), `export default "${noise(9_000)}";`);
    return dir;
}

test('the heaviest demo closure beyond the entry is measured, shared chunks included, entry chunks not', () => {
    const dir = demoSandbox(null);
    assert.strictEqual(run(dir, ['--update']).code, 0);
    const got = budgetOf(dir).demoJsGzip;
    // big (6 KB random, base64) + shared (9 KB) is about 15 KB * 1.03; vendor.js (20 KB) is already in the entry.
    assert.ok(got > 14_000 && got < 20_000, `demoJsGzip ${got}`);
});

test('a demo that grows past its budget fails and is named', () => {
    const dir = demoSandbox({ blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000, demoJsGzip: 10_000 });
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /demoJsGzip .* over the budget/);
});

test('a demo inside its budget passes, and a build without a demo registry skips the metric', () => {
    const ok = run(demoSandbox({ blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000, demoJsGzip: 40_000 }));
    assert.strictEqual(ok.code, 0, ok.stderr);
    const none = run(sandbox({ files: FILES, budget: { blockingCssBytes: 9_000, blockingCssGzip: 9_000, entryJsGzip: 40_000 } }));
    assert.strictEqual(none.code, 0, none.stderr);
});
