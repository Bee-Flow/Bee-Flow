/**
 * The mirrors are loaded by the browser bundle and the phone as if they were
 * the server's own files, so what has to hold is that write mode copies BYTES
 * (a CRLF, a BOM, a missing final newline and non-ASCII text all survive), and
 * that --check is a gate: it must refuse a differing byte, a missing file and
 * an extra one, name each of them, and write nothing while doing so. Test
 * files are outside the mirror on both sides. Every mirror in the MIRRORS
 * table is held to this, each with its own exclude and keep lists.
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

import { MIRRORS } from './gen-shared-mirror.mjs';

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

const MAPPING = {
    'index.mjs': "export * from './legacy.mjs';\n",
    'legacy.mjs': 'export const walk = () => 1;\n',
    'legacy.test.mjs': "import test from 'node:test';\n",
};

function sandbox(t, { source = { ...SOURCE, ...SOURCE_TESTS }, mapping = MAPPING } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-shared-mirror-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'gen-shared-mirror.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts', 'entry-point.mjs'));
    for (const [name, body] of Object.entries(source)) {
        const file = path.join(dir, 'server', 'shared', 'expr', name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    for (const [name, body] of Object.entries(mapping)) {
        const file = path.join(dir, 'server', 'shared', 'mapping', name);
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

test('the table mirrors expr and mapping to agent-hub and to the mobile vendor directories', () => {
    const pairs = MIRRORS.map((m) => `${m.source} -> ${m.target}`);
    assert.deepStrictEqual(pairs, [
        'server/shared/expr -> agent-hub/src/shared/expr',
        'server/shared/expr -> mobile/src/shared/expr/vendor',
        'server/shared/mapping -> agent-hub/src/shared/mapping',
        'server/shared/mapping -> mobile/src/shared/mapping/vendor',
    ]);
});

test('write mode fills every mirror; the mobile expr vendor leaves out the corpus and keeps its own declaration', (t) => {
    const dir = sandbox(t, { source: { ...SOURCE, 'corpus.mjs': 'export const CASES = [];\n' } });
    const vendor = (...p) => path.join(dir, 'mobile', 'src', 'shared', 'expr', 'vendor', ...p);
    fs.mkdirSync(vendor(), { recursive: true });
    fs.writeFileSync(vendor('index.d.mts'), 'export declare const f: () => string;\n');

    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(listing(dir), ['corpus.mjs', 'engine.mjs', 'functions.mjs', 'index.mjs']);
    assert.deepStrictEqual(fs.readdirSync(vendor()).sort(), ['engine.mjs', 'functions.mjs', 'index.d.mts', 'index.mjs']);
    for (const target of ['agent-hub/src/shared/mapping', 'mobile/src/shared/mapping/vendor']) {
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, target)).sort(), ['index.mjs', 'legacy.mjs'], target);
        assert.strictEqual(fs.readFileSync(path.join(dir, target, 'legacy.mjs'), 'utf8'), MAPPING['legacy.mjs']);
    }

    const check = run(dir, ['--check']);
    assert.strictEqual(check.code, 0, check.stderr);
    assert.match(check.stdout, /mobile\/src\/shared\/expr\/vendor\/ matches server\/shared\/expr\/ \(3 files\)/);
    assert.match(check.stdout, /mobile\/src\/shared\/mapping\/vendor\/ matches server\/shared\/mapping\/ \(2 files\)/);
});

test('--check names the one mirror that drifted, still reports the others, and fails', (t) => {
    const dir = sandbox(t);
    run(dir);
    const stale = path.join(dir, 'mobile', 'src', 'shared', 'mapping', 'vendor', 'legacy.mjs');
    fs.writeFileSync(stale, 'export const walk = () => 2;\n');

    const r = run(dir, ['--check']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /differs: mobile\/src\/shared\/mapping\/vendor\/legacy\.mjs \(first difference at line 1\)/);
    assert.match(r.stdout, /agent-hub\/src\/shared\/mapping\/ matches/);
    assert.match(r.stdout, /agent-hub\/src\/shared\/expr\/ matches/);
    assert.strictEqual(fs.readFileSync(stale, 'utf8'), 'export const walk = () => 2;\n', '--check never writes');

    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(fs.readFileSync(stale, 'utf8'), MAPPING['legacy.mjs']);
});

test('a missing mapping source fails before any mirror is written', (t) => {
    const dir = sandbox(t, { mapping: {} });
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /server\/shared\/mapping\/ has no files to mirror/);
    assert.ok(!fs.existsSync(mirror(dir)), 'not even the expr mirror is written');
});
