/**
 * The mirror is loaded by the browser bundle as if it were the server's own
 * file, so what has to hold is that write mode copies BYTES (a CRLF, a BOM, a
 * missing final newline and non-ASCII text all survive), and that --check is
 * a gate: it must refuse a differing byte, a missing file and an extra one,
 * name each of them, and write nothing while doing so. Test files are outside
 * the mirror on both sides.
 *
 * Sandbox style: scripts/gen-i18n-defaults.test.mjs — a throwaway tree under
 * os.tmpdir() with the real script copied in and a tiny fixture engine.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'gen-shared-mirror.mjs');

const SOURCE = {
    'engine.mjs': "export { f } from './functions.mjs';\n",
    // CRLF, a BOM, non-ASCII and no final newline: a text-mode copy would lose one.
    'functions.mjs': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const f = () => "€ — ü";\r\n// last line')]),
    'index.mjs': "export * from './engine.mjs';\n",
};
const SOURCE_TESTS = {
    'engine.test.mjs': "import test from 'node:test';\n",
    'functions.format.test.mjs': "import test from 'node:test';\n",
};

const EXPR_ENTRY = { source: 'server/shared/expr', target: 'agent-hub/src/shared/expr', transform: 'none' };

function writeManifest(dir, entries) {
    fs.writeFileSync(path.join(dir, 'scripts', 'shared-mirror.manifest.json'), JSON.stringify({ entries }, null, 4));
}

function writeTree(dir, rel, files) {
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(dir, rel, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
}

function sandbox(t, { source = { ...SOURCE, ...SOURCE_TESTS }, entries = [EXPR_ENTRY] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-shared-mirror-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'gen-shared-mirror.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts', 'entry-point.mjs'));
    writeManifest(dir, entries);
    for (const [name, body] of Object.entries(source)) {
        const file = path.join(dir, 'server', 'shared', 'expr', name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'gen-shared-mirror.mjs'), ...extra], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const mirror = (dir, name = '') => path.join(dir, 'agent-hub', 'src', 'shared', 'expr', name);
const listing = (dir) => fs.readdirSync(mirror(dir)).sort();

test('write mode copies every non-test source file byte for byte, and nothing else', (t) => {
    const dir = sandbox(t);
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote agent-hub\/src\/shared\/expr\/functions\.mjs/);
    assert.match(r.stdout, /now matches server\/shared\/expr\/ \(3 files\)/);
    assert.deepStrictEqual(listing(dir), ['engine.mjs', 'functions.mjs', 'index.mjs'], 'no test file is copied');
    for (const [name, body] of Object.entries(SOURCE)) {
        assert.ok(fs.readFileSync(mirror(dir, name)).equals(Buffer.from(body)), `${name} is byte-identical`);
    }

    const again = run(dir);
    assert.strictEqual(again.code, 0, again.stderr);
    assert.match(again.stdout, /already up to date \(3 files\)/);
});

test('--check passes on equal trees', (t) => {
    const dir = sandbox(t);
    run(dir);
    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /agent-hub\/src\/shared\/expr\/ matches server\/shared\/expr\/ \(3 files\)/);
});

test('--check fails on one differing byte, names the file and line, and writes nothing', (t) => {
    const dir = sandbox(t);
    run(dir);
    const edited = Buffer.from(fs.readFileSync(mirror(dir, 'functions.mjs')));
    edited[edited.length - 1] ^= 0x20; // 'e' -> 'E' on the second line
    fs.writeFileSync(mirror(dir, 'functions.mjs'), edited);

    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /differs: agent-hub\/src\/shared\/expr\/functions\.mjs \(first difference at line 2\)/);
    assert.doesNotMatch(r.stderr, /engine\.mjs|index\.mjs/, 'only the file that differs is named');
    assert.match(r.stderr, /npm run gen:shared/);
    assert.ok(fs.readFileSync(mirror(dir, 'functions.mjs')).equals(edited), '--check never writes');
});

// node realpaths import.meta.url but not argv[1]. A naive entry check then
// skips main() when the script is started through a symlink (a linked
// checkout, macOS's /var -> /private/var), and the gate exits 0 on drift.
test('--check still runs when the script is started through a symlinked path', (t) => {
    const dir = sandbox(t);
    run(dir);
    fs.appendFileSync(mirror(dir, 'engine.mjs'), '// drift\n');
    const link = `${dir}-link`;
    try {
        fs.symlinkSync(dir, link, 'dir');
    } catch (e) {
        t.skip(`cannot create a symlink here (${e.code})`);
        return;
    }
    t.after(() => fs.rmSync(link, { force: true }));

    const r = run(link, ['--check']);
    assert.strictEqual(r.code, 1, r.stdout);
    assert.match(r.stderr, /differs: agent-hub\/src\/shared\/expr\/engine\.mjs/);
});

test('--check fails on a missing file and on an extra one, and writes nothing', (t) => {
    const dir = sandbox(t);
    run(dir);
    fs.rmSync(mirror(dir, 'engine.mjs'));
    fs.writeFileSync(mirror(dir, 'stale.mjs'), 'export const old = 1;\n');

    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /missing: agent-hub\/src\/shared\/expr\/engine\.mjs/);
    assert.match(r.stderr, /extra: {3}agent-hub\/src\/shared\/expr\/stale\.mjs \(not in server\/shared\/expr\/\)/);
    assert.deepStrictEqual(listing(dir), ['functions.mjs', 'index.mjs', 'stale.mjs'], '--check never writes or deletes');

    const w = run(dir);
    assert.strictEqual(w.code, 0, w.stderr);
    assert.match(w.stdout, /removed agent-hub\/src\/shared\/expr\/stale\.mjs/);
    assert.deepStrictEqual(listing(dir), ['engine.mjs', 'functions.mjs', 'index.mjs']);
    assert.strictEqual(run(dir, ['--check']).code, 0);
});

test('--check fails when the mirror directory does not exist at all', (t) => {
    const dir = sandbox(t);
    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    for (const name of Object.keys(SOURCE)) assert.match(r.stderr, new RegExp(`missing: agent-hub/src/shared/expr/${name.replace('.', '\\.')}`));
    assert.ok(!fs.existsSync(mirror(dir)), '--check never creates the directory');
});

test('test files are never copied, never reported as extra, never removed', (t) => {
    const dir = sandbox(t);
    fs.mkdirSync(mirror(dir), { recursive: true });
    fs.writeFileSync(mirror(dir, 'own.test.mjs'), 'client-side test\n');
    fs.writeFileSync(mirror(dir, 'engine.spec.mjs'), 'another\n');

    assert.strictEqual(run(dir).code, 0);
    assert.deepStrictEqual(listing(dir), ['engine.mjs', 'engine.spec.mjs', 'functions.mjs', 'index.mjs', 'own.test.mjs']);
    assert.strictEqual(fs.readFileSync(mirror(dir, 'own.test.mjs'), 'utf8'), 'client-side test\n');
    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 0, r.stderr);
});

test('a source directory without files to mirror is an error, not a pass', (t) => {
    const dir = sandbox(t, { source: SOURCE_TESTS });
    for (const args of [[], ['--check']]) {
        const r = run(dir, args);
        assert.strictEqual(r.code, 1);
        assert.match(r.stderr, /server\/shared\/expr\/ has no files to mirror/);
    }
    assert.ok(!fs.existsSync(mirror(dir)));
});

// ---- manifest-driven entries -------------------------------------------------

const MOBILE_ENTRY = {
    source: 'server/shared/expr',
    target: 'mobile/src/shared/expr/vendor',
    exclude: ['functions.mjs'],
    keep: ['index.d.mts'],
};
const vendor = (dir, name = '') => path.join(dir, 'mobile', 'src', 'shared', 'expr', 'vendor', name);

test('a second target of the same source honours exclude and keeps hand-written files', (t) => {
    const dir = sandbox(t, { entries: [EXPR_ENTRY, MOBILE_ENTRY] });
    writeTree(dir, 'mobile/src/shared/expr/vendor', { 'index.d.mts': 'export declare const f: () => string;\n' });

    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(vendor(dir)).sort(), ['engine.mjs', 'index.d.mts', 'index.mjs']);
    assert.ok(fs.readFileSync(vendor(dir, 'engine.mjs')).equals(Buffer.from(SOURCE['engine.mjs'])), 'transform none stays byte-identical, no header');
    assert.strictEqual(run(dir, ['--check']).code, 0);

    fs.appendFileSync(vendor(dir, 'index.mjs'), '// hand edit\n');
    const c = run(dir, ['--check']);
    assert.strictEqual(c.code, 1);
    assert.match(c.stderr, /entry #2 \(server\/shared\/expr\/ -> mobile\/src\/shared\/expr\/vendor\/\)/, 'the failing entry is named');
    assert.match(c.stderr, /differs: mobile\/src\/shared\/expr\/vendor\/index\.mjs/);
    assert.doesNotMatch(c.stderr, /index\.d\.mts/, 'a kept file is never extra');
    assert.match(c.stdout, /agent-hub\/src\/shared\/expr\/ matches/, 'the clean entry still reports');
});

test('cjs-to-esm with importRewrite writes a GENERATED header and --check catches a hand edit', (t) => {
    const entries = [{
        source: 'server/shared/emoji',
        target: 'agent-hub/src/shared/emoji',
        transform: 'cjs-to-esm',
        importRewrite: [['./data', './data.js']],
    }];
    const dir = sandbox(t, { entries });
    writeTree(dir, 'server/shared/emoji', {
        'catalog.js': "'use strict';\nconst { list, size: count } = require('./data');\nconst path = require('node:path');\nconst all = () => list;\nmodule.exports = { all, total: count, path };\n",
    });

    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    const out = fs.readFileSync(path.join(dir, 'agent-hub/src/shared/emoji/catalog.js'), 'utf8');
    assert.strictEqual(out, '// GENERATED from server/shared/emoji/catalog.js by scripts/gen-shared-mirror.mjs — do not edit\n'
        + "import { list, size as count } from './data.js';\nimport path from 'node:path';\nconst all = () => list;\nexport { all, count as total, path };\n");
    assert.strictEqual(run(dir, ['--check']).code, 0);

    fs.writeFileSync(path.join(dir, 'agent-hub/src/shared/emoji/catalog.js'), out.replace('do not edit', 'edited'));
    const c = run(dir, ['--check']);
    assert.strictEqual(c.code, 1);
    assert.match(c.stderr, /differs: agent-hub\/src\/shared\/emoji\/catalog\.js \(first difference at line 1\)/);
});

test('a file source mirrors to a target file', (t) => {
    const entries = [{ source: 'server/shared/one.mjs', target: 'components/x/one.mjs' }];
    const dir = sandbox(t, { entries });
    writeTree(dir, 'server/shared', { 'one.mjs': 'export const one = 1;\n' });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'components/x/one.mjs'), 'utf8'), 'export const one = 1;\n');
    fs.rmSync(path.join(dir, 'components/x/one.mjs'));
    const c = run(dir, ['--check']);
    assert.strictEqual(c.code, 1);
    assert.match(c.stderr, /missing: components\/x\/one\.mjs/);
});

test('a file source with cjs-to-esm names the source file itself in its header', (t) => {
    const entries = [{ source: 'server/core/one.js', target: 'agent-hub/src/one.generated.mjs', transform: 'cjs-to-esm' }];
    const dir = sandbox(t, { entries });
    writeTree(dir, 'server/core', { 'one.js': 'const one = 1;\nmodule.exports = { one };\n' });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'agent-hub/src/one.generated.mjs'), 'utf8'),
        '// GENERATED from server/core/one.js by scripts/gen-shared-mirror.mjs — do not edit\nconst one = 1;\nexport { one };\n');
    assert.strictEqual(run(dir, ['--check']).code, 0);
});

test('cjs-to-esm refuses a file it cannot fully convert, and nothing is written for any entry', (t) => {
    const entries = [EXPR_ENTRY, { source: 'server/shared/dyn', target: 'agent-hub/src/shared/dyn', transform: 'cjs-to-esm' }];
    const dir = sandbox(t, { entries });
    writeTree(dir, 'server/shared/dyn', { 'lazy.js': "function load() { return require('./x'); }\nmodule.exports = { load };\n" });
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /cjs-to-esm: server\/shared\/dyn\/lazy\.js still has "require\("/);
    assert.ok(!fs.existsSync(mirror(dir)), 'the valid entry was not written either');
});

test('an unknown transform or key in the manifest is an error', (t) => {
    for (const bad of [{ ...EXPR_ENTRY, transform: 'babel' }, { ...EXPR_ENTRY, rewrite: [] }, { target: 'x' }]) {
        const dir = sandbox(t, { entries: [bad] });
        const r = run(dir, ['--check']);
        assert.strictEqual(r.code, 1);
        assert.match(r.stderr, /entry #1: (unknown transform|unknown key|source is required)/);
    }
});

test('the repo manifest mirrors the expr engine byte for byte to agent-hub and mobile', async () => {
    const { normaliseManifest } = await import('./gen-shared-mirror.mjs');
    const entries = normaliseManifest(JSON.parse(fs.readFileSync(path.join(HERE, 'shared-mirror.manifest.json'), 'utf8')));
    const expr = entries.filter((e) => e.source === 'server/shared/expr');
    assert.deepStrictEqual(expr.map((e) => e.target), ['agent-hub/src/shared/expr', 'mobile/src/shared/expr/vendor']);
    for (const e of expr) {
        assert.strictEqual(e.transform, 'none');
        assert.deepStrictEqual(e.importRewrite, []);
    }
});

const ROOTED = [
    { source: 'server/shared/expr/engine.mjs', target: 'gen/root/engine.mjs', transform: 'none' },
    { source: 'server/shared/expr/index.mjs', target: 'gen/root/index.mjs', transform: 'none' },
];

function rootedSandbox(t, entries = ROOTED) {
    const dir = sandbox(t, { entries });
    fs.writeFileSync(path.join(dir, 'scripts', 'shared-mirror.manifest.json'), JSON.stringify({ generatedRoots: ['gen/root'], entries }, null, 4));
    assert.strictEqual(run(dir).code, 0);
    return dir;
}

test('generatedRoots: a tree whose files are all targeted passes --check', (t) => {
    const dir = rootedSandbox(t);
    writeTree(dir, 'gen/root', { 'engine.test.mjs': 'a test is never stray\n' });
    assert.strictEqual(run(dir, ['--check']).code, 0);
});

test('generatedRoots: a stray hand-written file fails --check and is named', (t) => {
    const dir = rootedSandbox(t);
    writeTree(dir, 'gen/root/sub', { 'mine.ts': 'export {};\n' });
    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /stray: +gen\/root\/sub\/mine\.ts/);
});

test('generatedRoots: the leftover of a removed single entry fails --check', (t) => {
    const dir = rootedSandbox(t);
    fs.writeFileSync(path.join(dir, 'scripts', 'shared-mirror.manifest.json'), JSON.stringify({ generatedRoots: ['gen/root'], entries: ROOTED.slice(0, 1) }));
    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /stray: +gen\/root\/index\.mjs/);
    assert.doesNotMatch(r.stderr, /stray: +gen\/root\/engine\.mjs/);
});

test('generatedRoots: a directory entry\'s kept file is not stray', (t) => {
    const entry = { source: 'server/shared/expr', target: 'gen/root', transform: 'none', keep: ['index.d.mts'] };
    const dir = rootedSandbox(t, [entry]);
    writeTree(dir, 'gen/root', { 'index.d.mts': 'export {};\n' });
    assert.strictEqual(run(dir, ['--check']).code, 0);
});

test('the repo tree has no stray file under its generated roots', async () => {
    const { normaliseManifest, generatedRootsOf, strayFiles } = await import('./gen-shared-mirror.mjs');
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'shared-mirror.manifest.json'), 'utf8'));
    const roots = generatedRootsOf(manifest);
    assert.ok(roots.includes('mobile/src/features/flow-editor/bindings/mirror'));
    assert.deepStrictEqual(strayFiles(normaliseManifest(manifest), roots, path.resolve(HERE, '..')), []);
});
