/**
 * The duplication ratchet reads a jscpd JSON report; these cases hand it one,
 * so the suite needs no jscpd install (test:scripts runs without `npm ci`).
 * What matters: over budget fails, --update only lowers, and a report that is
 * missing or shapeless is never a pass.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'duplication-ratchet.mjs');

const clone = (lines, a = 'a.js', b = 'b.js') => ({ lines, firstFile: { name: a, start: 1 }, secondFile: { name: b, start: 9 } });
const reportOf = (duplicatedLines, duplicates = []) => ({ statistics: { total: { duplicatedLines, percentage: 1.2 } }, duplicates });

function sandbox({ report = reportOf(120), budget = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/duplication-ratchet.mjs'));
    if (report !== null) fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    if (budget !== null) fs.writeFileSync(path.join(dir, '.jscpd-ratchet.json'), JSON.stringify({ duplicatedLines: budget }));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/duplication-ratchet.mjs'), '--report', 'report.json', ...extra], { cwd: dir, encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.jscpd-ratchet.json'), 'utf8')).duplicatedLines;

test('more duplicated lines than the budget fails', () => {
    const r = run(sandbox({ report: reportOf(130), budget: 120 }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /130 duplicated lines, budget is 120/);
});

test('at or under the budget passes', () => {
    assert.strictEqual(run(sandbox({ report: reportOf(120), budget: 120 })).code, 0);
    assert.match(run(sandbox({ report: reportOf(90), budget: 120 })).stdout, /under the budget of 120/);
});

test('--update lowers the budget and never raises it', () => {
    const down = sandbox({ report: reportOf(90), budget: 120 });
    run(down, ['--update']);
    assert.strictEqual(budgetOf(down), 90);
    const up = sandbox({ report: reportOf(200), budget: 120 });
    run(up, ['--update']);
    assert.strictEqual(budgetOf(up), 120);
});

test('the first measurement writes the budget', () => {
    const dir = sandbox({ report: reportOf(77) });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 77);
});

test('--list names the largest clones first', () => {
    const r = run(sandbox({ report: reportOf(60, [clone(10, 'small.js'), clone(50, 'big.js')]), budget: 60 }), ['--list']);
    assert.match(r.stdout, /50 {2}big\.js:1 ↔ b\.js:9\n\s+10 {2}small\.js/);
});

test('a missing or shapeless report is an error, not a pass', () => {
    assert.strictEqual(run(sandbox({ report: null, budget: 1 })).code, 2);
    const r = run(sandbox({ report: { statistics: {} }, budget: 1 }));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /duplicatedLines/);
});
