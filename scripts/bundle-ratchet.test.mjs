/**
 * The bundle budget reads a built dist/assets tree. These cases build a fake
 * one from incompressible bytes, so the gzip size is known in advance.
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
const SCRIPT = path.join(HERE, 'bundle-ratchet.mjs');

function sandbox({ chunks = {}, budget = null, build = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/bundle-ratchet.mjs'));
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    if (build) fs.mkdirSync(path.join(dir, 'pkg/dist/assets'), { recursive: true });
    for (const [name, bytes] of Object.entries(chunks)) {
        // Random bytes do not compress, so gzip ≈ bytes (plus a small header).
        fs.writeFileSync(path.join(dir, 'pkg/dist/assets', name), crypto.randomBytes(bytes));
    }
    if (budget) fs.writeFileSync(path.join(dir, 'pkg/.bundle-budget.json'), JSON.stringify(budget));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/bundle-ratchet.mjs'), 'pkg', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.bundle-budget.json'), 'utf8'));

test('a build inside both budgets passes', () => {
    const r = run(sandbox({ chunks: { 'a.js': 10_000, 'b.css': 5_000 }, budget: { totalGzip: 20_000, largestGzip: 12_000 } }));
    assert.strictEqual(r.code, 0, r.stderr);
});

test('a total over budget fails', () => {
    const r = run(sandbox({ chunks: { 'a.js': 10_000, 'b.js': 10_000 }, budget: { totalGzip: 15_000, largestGzip: 50_000 } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /total .* is over the budget/);
});

test('one chunk over the largest-chunk budget fails and is named', () => {
    const r = run(sandbox({ chunks: { 'vendor.js': 30_000, 'a.js': 1_000 }, budget: { totalGzip: 100_000, largestGzip: 20_000 } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /largest chunk vendor\.js/);
});

test('--update writes the measurement plus 5% headroom', () => {
    const dir = sandbox({ chunks: { 'a.js': 20_000 } });
    run(dir, ['--update']);
    const b = budgetOf(dir);
    assert.ok(b.totalGzip > 20_000 * 1.04 && b.totalGzip < 20_100 * 1.06, String(b.totalGzip));
    assert.strictEqual(b.totalGzip, b.largestGzip);
});

test('files that are not js or css do not count', () => {
    const dir = sandbox({ chunks: { 'a.js': 1_000, 'logo.png': 500_000, 'font.woff2': 90_000 } });
    run(dir);
    assert.ok(budgetOf(dir).totalGzip < 2_000);
});

test('no build is an error, not a pass', () => {
    const r = run(sandbox({ build: false }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /run the build first/);
});
