/**
 * The splitter moves 15,000 keys at once, so what has to hold is that NOTHING
 * changes on the way: the merged dictionary deep-equals the monolith, and the
 * comments travel with the key they belong to — a section header with the key
 * below it, a closing `// ── end … ──` with the key above it. After that, the
 * two properties that make it a merge tool: a second run changes nothing, and
 * a monolith that comes back (a branch resolving its merge) adds its new keys
 * without taking away the ones that landed after the split.
 *
 * Also here: the generated index.js refuses what used to fail silently — a key
 * in the wrong namespace file, and a namespace file nobody listed.
 *
 * The splitter needs acorn, which it resolves from server/node_modules. The
 * scripts suite runs without `npm ci`, so the sandbox borrows the real
 * checkout's acorn when it is installed and these tests SKIP when it is not.
 * Sandbox style: scripts/count-ratchet.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'i18n-split.mjs');
const ACORN = path.join(HERE, '..', 'server', 'node_modules', 'acorn');
const NO_ACORN = !fs.existsSync(path.join(ACORN, 'package.json')) && 'acorn not installed (npm ci in server/)';

const MONOLITH = `/**
 * English GUI String Defaults (fixture)
 */

const GUI_DEFAULTS = {
    // ── Section A ──
    'a.one': 'One',
    "b.two": "Two, it's", // trailing note

    // ── Block ──
    'a.three': 'Three { // not a comment',
    'a.multi':
        'spans two lines',
    // ── end Block ──

    greet: 'Hi {name}',
};

function getGUINamespaces() {
    return [...new Set(Object.keys(GUI_DEFAULTS).map((k) => k.split('.')[0]))].sort();
}

module.exports = { GUI_DEFAULTS, getGUINamespaces };
`;

function sandbox(monolith = MONOLITH) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-split-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'i18n-split.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts', 'entry-point.mjs'));
    fs.mkdirSync(path.join(dir, 'server', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'package.json'), '{"name":"fixture"}\n');
    fs.symlinkSync(fs.realpathSync(ACORN), path.join(dir, 'server', 'node_modules', 'acorn'), 'dir');
    fs.mkdirSync(path.join(dir, 'server', 'i18n', 'defaults'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'), monolith);
    return dir;
}

function run(dir) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'i18n-split.mjs')], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const enDir = (dir) => path.join(dir, 'server', 'i18n', 'defaults', 'en');
const read = (dir, f) => fs.readFileSync(path.join(enDir(dir), f), 'utf8');
/** Fresh require every time: the sandbox files change between calls. */
function load(file) {
    const req = createRequire(file);
    for (const k of Object.keys(req.cache)) if (k.startsWith(path.dirname(path.dirname(file)))) delete req.cache[k];
    return req(file);
}
function snapshot(dir) {
    return Object.fromEntries(fs.readdirSync(enDir(dir)).sort().map((f) => [f, read(dir, f)]));
}

test('the split dictionary deep-equals the monolith, one file per namespace', { skip: NO_ACORN }, () => {
    const dir = sandbox();
    const before = load(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'));
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(enDir(dir)).sort(), ['a.js', 'b.js', 'greet.js', 'index.js']);
    const after = load(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'));
    assert.deepStrictEqual({ ...after.GUI_DEFAULTS }, { ...before.GUI_DEFAULTS });
    assert.deepStrictEqual(after.getGUINamespaces(), ['a', 'b', 'greet']);
    assert.match(fs.readFileSync(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'), 'utf8'), /module\.exports = require\('\.\/en\/index\.js'\);/);
});

test('comments travel verbatim with the key they belong to', { skip: NO_ACORN }, () => {
    const dir = sandbox();
    assert.strictEqual(run(dir).code, 0);
    const a = read(dir, 'a.js');
    // The section header stays above its key; the closing marker below the block.
    assert.match(a, /module\.exports = \{\n {4}\/\/ ── Section A ──\n {4}'a\.one': 'One',\n/);
    assert.match(a, /'a\.multi':\n {8}'spans two lines',\n {4}\/\/ ── end Block ──\n\};\n$/);
    assert.match(a, /\n\n {4}\/\/ ── Block ──\n {4}'a\.three': 'Three \{ \/\/ not a comment',\n/);
    assert.match(read(dir, 'b.js'), / {4}"b\.two": "Two, it's", \/\/ trailing note\n\};\n$/);
    assert.match(read(dir, 'greet.js'), / {4}greet: 'Hi \{name\}',\n\};\n$/);
});

test('a second run changes nothing', { skip: NO_ACORN }, () => {
    const dir = sandbox();
    assert.strictEqual(run(dir).code, 0);
    const first = snapshot(dir);
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /already the re-export/);
    assert.deepStrictEqual(snapshot(dir), first);
});

test('a monolith that comes back is merged: its new keys land, keys added since the split stay', { skip: NO_ACORN }, () => {
    const dir = sandbox();
    assert.strictEqual(run(dir).code, 0);
    // main, after the split: a key added to b.js.
    fs.writeFileSync(path.join(enDir(dir), 'b.js'), read(dir, 'b.js').replace('};\n', "    'b.late': 'Late',\n};\n"));
    // the branch: its own monolith, with a new key and a different English for a.one.
    const branch = MONOLITH
        .replace("'a.one': 'One',", "'a.one': 'Uno',")
        .replace('    greet:', "    'a.four': 'Four',\n    'c.new': 'New namespace',\n    greet:");
    fs.writeFileSync(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'), branch);
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    const { GUI_DEFAULTS } = load(path.join(dir, 'server', 'i18n', 'defaults', 'en.js'));
    assert.strictEqual(GUI_DEFAULTS['b.late'], 'Late');
    assert.strictEqual(GUI_DEFAULTS['a.four'], 'Four');
    assert.strictEqual(GUI_DEFAULTS['c.new'], 'New namespace');
    assert.strictEqual(GUI_DEFAULTS['a.one'], 'One', 'the namespace file wins a differing value');
    assert.match(r.stdout, /a\.one[\s\S]*"One"[\s\S]*"Uno"/, 'and the difference is reported');
    assert.match(read(dir, 'index.js'), /"c":\s+require\('\.\/c\.js'\)/);
});

test('index.js throws on a key in the wrong file and on an unlisted file', { skip: NO_ACORN }, () => {
    const dir = sandbox();
    assert.strictEqual(run(dir).code, 0);
    const entry = path.join(enDir(dir), 'index.js');
    const a = read(dir, 'a.js');
    fs.writeFileSync(path.join(enDir(dir), 'a.js'), a.replace('};\n', "    'b.stray': 'x',\n};\n"));
    assert.throws(() => load(entry), /"b\.stray" is in en\/a\.js but its namespace is "b"/);
    fs.writeFileSync(path.join(enDir(dir), 'a.js'), a);
    fs.writeFileSync(path.join(enDir(dir), 'zz.js'), "module.exports = { 'zz.x': 'x' };\n");
    assert.throws(() => load(entry), /zz\.js .* is not listed in NAMESPACES/);
});

test('a duplicated key in the monolith stops the split instead of picking one', { skip: NO_ACORN }, () => {
    const dir = sandbox(MONOLITH.replace("'a.three':", "'a.one': 'Again',\n    'a.three':"));
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /a\.one is defined twice/);
    assert.ok(!fs.existsSync(path.join(enDir(dir), 'a.js')));
});
