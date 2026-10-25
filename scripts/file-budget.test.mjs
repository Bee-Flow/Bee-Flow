/**
 * The file budget is a gate, so the cases that matter are the ones where it
 * has to REFUSE: a new file over the limit, a budgeted file past its ceiling,
 * a stale data exemption, and an --update that would add a file or raise a
 * ceiling. Next to those: that the exemptions really exempt (data globs,
 * gitignored files, build output) and that tests get their own limit.
 *
 * Sandbox style is count-ratchet.test.mjs's: a throwaway repo under
 * os.tmpdir(), the real script (and entry-point.mjs) copied in, the package
 * tree built from whatever path → contents the case asks for.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { globToRegExp, lineCount } from './file-budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

function sandbox({ files = {}, budget = null, pkg = 'pkg', git = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-budget-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    for (const name of ['file-budget.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, name), path.join(dir, 'scripts', name));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, pkg, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    fs.mkdirSync(path.join(dir, pkg), { recursive: true });
    if (budget !== null) fs.writeFileSync(path.join(dir, pkg, '.file-budget.json'), JSON.stringify({ limit: 400, testLimit: 1000, data: [], files: {}, ...budget }));
    if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}

function run(dir, extra = [], pkgs = ['pkg']) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/file-budget.mjs'), ...pkgs, ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir, pkg = 'pkg') => JSON.parse(fs.readFileSync(path.join(dir, pkg, '.file-budget.json'), 'utf8'));

test('lineCount counts like wc -l, plus a last line without a newline', () => {
    assert.strictEqual(lineCount(''), 0);
    assert.strictEqual(lineCount('a\nb\n'), 2);
    assert.strictEqual(lineCount('a\nb'), 2);
});

test('globs: * stays in one segment, ** crosses them', () => {
    assert.ok(globToRegExp('templates/*').test('templates/a.js'));
    assert.ok(!globToRegExp('templates/*').test('templates/x/a.js'));
    assert.ok(globToRegExp('templates/**').test('templates/x/a.js'));
    assert.ok(globToRegExp('**/schemas.js').test('schemas.js'));
    assert.ok(globToRegExp('**/schemas.js').test('a/b/schemas.js'));
    assert.ok(globToRegExp('core/*.cjs').test('core/x.cjs'));
    assert.ok(!globToRegExp('core/*.cjs').test('core/xcjs'), 'a dot is literal');
});

test('the first run writes every file over the limit at its measured size', () => {
    const dir = sandbox({ files: { 'big.js': lines(450), 'small.js': lines(10), 'a.test.js': lines(900), 'huge.test.js': lines(1200) } });
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    const budget = budgetOf(dir);
    assert.deepStrictEqual(budget.files, { 'big.js': 450, 'huge.test.js': 1200 });
    assert.strictEqual(budget.limit, 400);
    assert.strictEqual(budget.testLimit, 1000);
    assert.match(budget._comment, /only come down/);
});

test('a new file over the limit fails and says what to do', () => {
    const r = run(sandbox({ files: { 'big.js': lines(401) }, budget: {} }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /big\.js has 401 lines, over the 400-line limit — split it/);
});

test('a test file gets the test limit', () => {
    assert.strictEqual(run(sandbox({ files: { 'x.test.ts': lines(999), 'y.spec.jsx': lines(1000) }, budget: {} })).code, 0);
    const r = run(sandbox({ files: { 'x.test.ts': lines(1001) }, budget: {} }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /1000-line test limit/);
});

test('a budgeted file may not grow past its ceiling', () => {
    const r = run(sandbox({ files: { 'big.js': lines(451) }, budget: { files: { 'big.js': 450 } } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /big\.js grew to 451 lines, its ceiling is 450/);
});

test('a file that shrank passes, and --update lowers its ceiling and drops the ones back under the limit', () => {
    const dir = sandbox({
        files: { 'big.js': lines(420), 'fixed.js': lines(300) },
        budget: { files: { 'big.js': 450, 'fixed.js': 600, 'deleted.js': 900 } },
    });
    const gate = run(dir);
    assert.strictEqual(gate.code, 0, gate.stderr);
    assert.match(gate.stdout, /3 ceilings can come down/);
    const upd = run(dir, ['--update']);
    assert.strictEqual(upd.code, 0, upd.stderr);
    assert.deepStrictEqual(budgetOf(dir).files, { 'big.js': 420 });
    assert.match(run(dir).stdout, /at budget/);
});

test('--update never raises a ceiling or adds a file', () => {
    const dir = sandbox({ files: { 'big.js': lines(500), 'new.js': lines(450) }, budget: { files: { 'big.js': 450 } } });
    const r = run(dir, ['--update']);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(budgetOf(dir).files, { 'big.js': 450 });
    assert.match(r.stderr, /never adds a file or raises a ceiling/);
});

test('data globs are skipped, and one that matches nothing fails', () => {
    const data = [{ glob: 'templates/**', reason: 'content' }, { glob: 'gen/*.cjs', reason: 'bundle' }];
    const ok = run(sandbox({ files: { 'templates/x/app.js': lines(3000), 'gen/b.cjs': lines(900) }, budget: { data } }));
    assert.strictEqual(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /2 data files skipped/);
    const stale = run(sandbox({ files: { 'templates/app.js': lines(3000) }, budget: { data } }));
    assert.strictEqual(stale.code, 1);
    assert.match(stale.stderr, /data entry "gen\/\*\.cjs" .* matches no file/);
});

test('build output and dependencies cannot move a number', () => {
    const files = { 'node_modules/dep/index.js': lines(5000), 'dist/bundle.js': lines(5000), 'coverage/x.js': lines(900) };
    assert.strictEqual(run(sandbox({ files, budget: {} })).code, 0);
});

test('in a git work tree, gitignored files do not count and untracked ones do', () => {
    const dir = sandbox({ git: true, files: { '.gitignore': 'data/\n', 'data/dump.js': lines(5000), 'new.js': lines(401) }, budget: {} });
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /new\.js has 401 lines/);
    assert.doesNotMatch(r.stderr, /dump\.js/);
});

test('guard-service measures Python with its own limit, and tests/ is test code', () => {
    const files = { 'app/x.py': '\n'.repeat(600), 'app/y.py': '\n'.repeat(601), 'tests/test_x.py': '\n'.repeat(1000), 'app/ignored.js': lines(900) };
    const dir = sandbox({ pkg: 'guard-service', files });
    assert.strictEqual(run(dir, [], ['guard-service']).code, 0);
    const budget = budgetOf(dir, 'guard-service');
    assert.strictEqual(budget.limit, 600);
    assert.deepStrictEqual(budget.files, { 'app/y.py': 601 });
});

test('--list shows the largest files first and marks the new ones', () => {
    const dir = sandbox({ files: { 'a.js': lines(450), 'b.js': lines(900), 'c.js': lines(410) }, budget: { files: { 'a.js': 450, 'b.js': 900 } } });
    const r = run(dir, ['--list', '--top', '2']);
    assert.strictEqual(r.code, 1);
    const listed = r.stdout.split('\n').filter((l) => /\.js$/.test(l));
    assert.deepStrictEqual(listed.map((l) => l.trim().split(/\s+/).pop()), ['b.js', 'a.js']);
    assert.match(r.stdout, /3 files over the limit/);
});

test('a missing package or no package is a usage error', () => {
    const dir = sandbox({ budget: {} });
    assert.strictEqual(run(dir, [], ['nope']).code, 2);
    assert.strictEqual(run(dir, [], []).code, 2);
});
