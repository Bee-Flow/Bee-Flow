/**
 * The coverage ratchet is a gate, so the cases that matter are refusals: a
 * total under the floor, an --update that would lower it, and a missing or
 * unreadable report — which must never read as "coverage is fine".
 *
 * Sandbox style as in scripts/count-ratchet.test.mjs: a throwaway repo under
 * os.tmpdir() with the real script copied in.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'coverage-ratchet.mjs');

const istanbul = (pct) => ({ total: { lines: { total: 100, covered: pct, pct } } });
const coveragePy = (pct) => ({ totals: { percent_covered: pct, covered_lines: 1 } });

function sandbox({ summary = istanbul(62.4), floor = null, summaryPath = 'pkg/coverage/coverage-summary.json' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/coverage-ratchet.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    if (summary !== null) {
        fs.mkdirSync(path.dirname(path.join(dir, summaryPath)), { recursive: true });
        fs.writeFileSync(path.join(dir, summaryPath), JSON.stringify(summary));
    }
    if (floor !== null) fs.writeFileSync(path.join(dir, 'pkg/.coverage-ratchet.json'), JSON.stringify({ lines: floor }));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/coverage-ratchet.mjs'), 'pkg', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const floorOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.coverage-ratchet.json'), 'utf8')).lines;

test('coverage under the floor fails, and says what to do instead', () => {
    const r = run(sandbox({ summary: istanbul(58.9), floor: 60 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /58\.90% is under the floor of 60%/);
    assert.match(r.stderr, /add tests/);
});

test('at or over the floor passes, and says when the floor can rise', () => {
    assert.strictEqual(run(sandbox({ summary: istanbul(60), floor: 60 })).code, 0);
    const r = run(sandbox({ summary: istanbul(70.2), floor: 60 }));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /raise it to 69%/);
});

test('the first measurement writes a floor one point under it', () => {
    const dir = sandbox({ summary: istanbul(62.4) });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(floorOf(dir), 61);
});

test('--update raises the floor and never lowers it', () => {
    const up = sandbox({ summary: istanbul(75.5), floor: 60 });
    assert.strictEqual(run(up, ['--update']).code, 0);
    assert.strictEqual(floorOf(up), 74);

    const down = sandbox({ summary: istanbul(50), floor: 60 });
    assert.strictEqual(run(down, ['--update']).code, 0);
    assert.strictEqual(floorOf(down), 60, 'an --update must not become a quiet way to lower the floor');
});

test("reads coverage.py's JSON as well as istanbul's summary", () => {
    const dir = sandbox({ summary: coveragePy(81.3), summaryPath: 'pkg/coverage.json', floor: 80 });
    const r = run(dir, ['--summary', 'pkg/coverage.json']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /81\.30%/);
});

test('a missing or unreadable report is a usage error, never a pass', () => {
    const missing = run(sandbox({ summary: null, floor: 60 }));
    assert.strictEqual(missing.code, 2);
    assert.match(missing.stderr, /not found/);

    const shapeless = run(sandbox({ summary: { total: {} }, floor: 60 }));
    assert.strictEqual(shapeless.code, 2);
    assert.match(shapeless.stderr, /no line total/);

    const noPkg = execFileSync(process.execPath, ['-e', `
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}]);
        process.stdout.write(String(r.status));
    `], { encoding: 'utf8' });
    assert.strictEqual(noPkg, '2');
});

const full = (lines, branches, functions) => ({ total: {
    lines: { pct: lines }, branches: { pct: branches }, functions: { pct: functions },
} });
const floorJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.coverage-ratchet.json'), 'utf8'));

function withFloor(summary, floor) {
    const dir = sandbox({ summary });
    fs.writeFileSync(path.join(dir, 'pkg/.coverage-ratchet.json'), JSON.stringify(floor));
    return dir;
}

test('a branches floor in the floor file gates branch coverage', () => {
    const r = run(withFloor(full(80, 60, 80), { lines: 70, branches: 70 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /branches coverage 60\.00% is under the floor of 70%/);
    assert.strictEqual(run(withFloor(full(80, 75, 80), { lines: 70, branches: 70 })).code, 0);
});

test('a functions floor gates function coverage, lines alone do not hide it', () => {
    const r = run(withFloor(full(90, 90, 30), { lines: 70, functions: 40 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /functions coverage 30\.00% is under the floor of 40%/);
    assert.doesNotMatch(r.stderr, /line coverage/);
});

test('without the keys only lines are gated', () => {
    assert.strictEqual(run(withFloor(full(80, 1, 1), { lines: 70 })).code, 0);
});

test('--update --also starts tracking branches and functions, and only raises them', () => {
    const dir = withFloor(full(80, 61.5, 55.2), { lines: 70 });
    assert.strictEqual(run(dir, ['--update', '--also', 'branches,functions']).code, 0);
    assert.deepStrictEqual([floorJson(dir).lines, floorJson(dir).branches, floorJson(dir).functions], [79, 60, 54]);
    // later update with lower measurements keeps the floors
    fs.writeFileSync(path.join(dir, 'pkg/coverage/coverage-summary.json'), JSON.stringify(full(70, 50, 40)));
    assert.strictEqual(run(dir, ['--update']).code, 0);
    assert.deepStrictEqual([floorJson(dir).lines, floorJson(dir).branches, floorJson(dir).functions], [79, 60, 54]);
});

test('a tracked metric missing from the report is a usage error', () => {
    const r = run(withFloor(istanbul(80), { lines: 70, branches: 50 }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /no branches total/);
});

test('--also rejects an unknown metric', () => {
    const r = run(sandbox({ summary: full(80, 80, 80), floor: 70 }), ['--update', '--also', 'statements']);
    assert.strictEqual(r.code, 2);
});
