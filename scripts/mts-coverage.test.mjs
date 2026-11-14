// Unit tests of the .mts coverage ratchet: which entries of the summary count,
// the totals per folder, and the floor (a drop fails, --update only raises).
// The gate cases run the real script in a throwaway repo, the way
// scripts/scc-ratchet.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { byFolder, floorFor, folderOf, mtsFiles, totals, verdict } from './mts-coverage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lines = (total, covered) => ({ lines: { total, covered, skipped: 0, pct: 0 } });

test('only .mts entries count, with package-relative names; the total row and JavaScript are left out', () => {
    const pkg = path.join(path.sep, 'repo', 'server');
    const summary = {
        total: lines(1000, 900),
        [path.join(pkg, 'auth', 'a.mts')]: lines(10, 5),
        [path.join(pkg, 'auth', 'b.js')]: lines(100, 100),
        [path.join(pkg, 'core', 'kb', 'c.mts')]: lines(30, 30),
        [path.join(pkg, 'index.mts')]: lines(4, 0),
    };
    const files = mtsFiles(summary, pkg);
    assert.deepEqual(files, [
        { file: 'auth/a.mts', total: 10, covered: 5 },
        { file: 'core/kb/c.mts', total: 30, covered: 30 },
        { file: 'index.mts', total: 4, covered: 0 },
    ]);
    assert.deepEqual(totals(files), { files: 3, covered: 35, total: 44, pct: (35 / 44) * 100 });
    assert.equal(totals([]).pct, null);
});

test('folders: the big ones one level deeper, the most uncovered lines first', () => {
    assert.equal(folderOf('index.mts'), '(root)');
    assert.equal(folderOf('auth/connector/x.mts'), 'auth');
    assert.equal(folderOf('core/kb/x.mts'), 'core/kb');
    assert.equal(folderOf('core/x.mts'), 'core');
    const rows = byFolder([
        { file: 'auth/a.mts', total: 10, covered: 5 },
        { file: 'core/kb/c.mts', total: 30, covered: 30 },
        { file: 'core/kb/d.mts', total: 10, covered: 0 },
    ]);
    assert.deepEqual(rows.map((r) => [r.folder, r.files, r.covered, r.total]), [['core/kb', 2, 30, 40], ['auth', 1, 5, 10]]);
});

test('the floor sits one point under the measurement; a drop fails and --update never lowers', () => {
    assert.equal(floorFor(82.2), 81);
    assert.equal(floorFor(0.4), 0);
    assert.deepEqual(verdict(82.2, null, false), { status: 'write', next: 81 });
    assert.deepEqual(verdict(80.9, { lines: 81 }, false), { status: 'fail' });
    assert.deepEqual(verdict(81, { lines: 81 }, false), { status: 'at' });
    assert.deepEqual(verdict(82.9, { lines: 81 }, false), { status: 'at' });
    assert.deepEqual(verdict(84.5, { lines: 81 }, false), { status: 'raise', next: 83 });
    assert.deepEqual(verdict(84.5, { lines: 81 }, true), { status: 'write', next: 83 });
    assert.deepEqual(verdict(70, { lines: 81 }, true), { status: 'write', next: 81 }, '--update never lowers the floor');
});

function sandbox(summary, floor = null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-coverage-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['mts-coverage.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    fs.mkdirSync(path.join(dir, 'pkg', 'coverage'), { recursive: true });
    if (summary) fs.writeFileSync(path.join(dir, 'pkg', 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
    if (floor !== null) fs.writeFileSync(path.join(dir, 'pkg', '.mts-coverage-ratchet.json'), JSON.stringify({ lines: floor }));
    return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'mts-coverage.mjs'), 'pkg', ...args], { cwd: dir, encoding: 'utf8' });
const floorOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg', '.mts-coverage-ratchet.json'), 'utf8')).lines;

test('the gate: under the floor exits 1, at it exits 0, a missing or .mts-less report exits 2', () => {
    const half = { total: lines(200, 190), 'a/x.mts': lines(100, 50), 'a/y.js': lines(100, 100) };
    const under = run(sandbox(half, 60));
    assert.equal(under.status, 1, under.stdout + under.stderr);
    assert.match(under.stderr, /50\.00% is under the floor of 60%/);

    const at = run(sandbox(half, 49));
    assert.equal(at.status, 0, at.stderr);
    assert.match(at.stdout, /a +1 +50 \/ +100 +50\.0%/);

    assert.equal(run(sandbox(null, 49)).status, 2);
    assert.equal(run(sandbox({ total: lines(1, 1), 'a/y.js': lines(1, 1) }, 49)).status, 2);
});

test('--update raises the floor to one point under the measurement and never lowers it', () => {
    const summary = { total: lines(100, 90), 'a/x.mts': lines(100, 90) };
    const first = sandbox(summary);
    assert.equal(run(first).status, 0);
    assert.equal(floorOf(first), 89);

    const raised = sandbox(summary, 70);
    assert.equal(run(raised, '--update').status, 0);
    assert.equal(floorOf(raised), 89);

    const kept = sandbox(summary, 95);
    assert.equal(run(kept, '--update').status, 0);
    assert.equal(floorOf(kept), 95);
});
