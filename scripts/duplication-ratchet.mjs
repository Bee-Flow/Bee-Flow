#!/usr/bin/env node
/**
 * Duplication ratchet — copy-pasted lines across the repository may only fall.
 *
 * jscpd has been in the root devDependencies, with a config (.jscpd.json), since
 * the baseline measurement; nothing ever compared its number with anything, so
 * a PR could paste a 200-line block and no check would notice. This script runs
 * jscpd with its JSON reporter, reads `statistics.total.duplicatedLines`, and
 * compares it with the budget in `.jscpd-ratchet.json`.
 *
 * Lines, not the percentage: the percentage falls when unrelated code is added,
 * so a PR could add a clone and still lower it. The absolute count moves only
 * when duplication does.
 *
 * Usage:
 *   node scripts/duplication-ratchet.mjs                    gate (runs jscpd; root `npm ci` first)
 *   node scripts/duplication-ratchet.mjs --update           lower the budget
 *   node scripts/duplication-ratchet.mjs --report <file>    read an existing jscpd JSON report
 *   node scripts/duplication-ratchet.mjs --list             the largest clones, biggest first
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = path.join(ROOT, '.jscpd-ratchet.json');

const args = process.argv.slice(2);
const update = args.includes('--update');
const list = args.includes('--list');
const reportAt = args.indexOf('--report');
if (reportAt >= 0 && !args[reportAt + 1]) {
    console.error('duplication-ratchet: --report needs a file');
    process.exit(2);
}

function runJscpd() {
    // jscpd 5 ships a native binary behind a small launcher; its package.json
    // names the launcher, so read it rather than guessing the path.
    const pkgFile = path.join(ROOT, 'node_modules', 'jscpd', 'package.json');
    const launcher = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')).bin : null;
    const bin = launcher && path.join(ROOT, 'node_modules', 'jscpd', typeof launcher === 'string' ? launcher : launcher.jscpd);
    if (!bin || !fs.existsSync(bin)) {
        console.error('duplication-ratchet: jscpd is not installed — run `npm ci` in the repo root first. A scan that did not run is not a pass.');
        process.exit(2);
    }
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));
    const r = spawnSync(process.execPath, [bin, '.', '--config', '.jscpd.json', '--reporters', 'json', '--output', out, '--no-colors'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    const file = path.join(out, 'jscpd-report.json');
    if (r.status !== 0 || !fs.existsSync(file)) {
        console.error(`duplication-ratchet: jscpd exited ${r.status} without a report`);
        process.exit(2);
    }
    return file;
}

const reportFile = reportAt >= 0 ? path.resolve(ROOT, args[reportAt + 1]) : runJscpd();
if (!fs.existsSync(reportFile)) {
    console.error(`duplication-ratchet: ${reportFile} not found`);
    process.exit(2);
}
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const lines = report?.statistics?.total?.duplicatedLines;
if (typeof lines !== 'number') {
    console.error('duplication-ratchet: the report has no statistics.total.duplicatedLines');
    process.exit(2);
}

if (list) {
    const clones = [...(report.duplicates || [])].sort((a, b) => b.lines - a.lines).slice(0, 25);
    for (const c of clones) {
        console.log(`${String(c.lines).padStart(5)}  ${c.firstFile.name}:${c.firstFile.start} ↔ ${c.secondFile.name}:${c.secondFile.start}`);
    }
    console.log('');
}

const existing = fs.existsSync(BUDGET_FILE) ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) : null;

if (update || !existing) {
    const next = {
        _comment: 'Highest number of duplicated lines (jscpd, .jscpd.json) the repository may carry. Lower it with `node scripts/duplication-ratchet.mjs --update` after removing clones; raising it is a deliberate edit that belongs in a commit message with a reason.',
        _generated: new Date().toISOString().slice(0, 10),
        duplicatedLines: existing ? Math.min(lines, existing.duplicatedLines) : lines,
    };
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Budget written to .jscpd-ratchet.json: ${next.duplicatedLines} duplicated lines (measured ${lines})`);
    process.exit(0);
}

if (lines > existing.duplicatedLines) {
    console.error(`❌ ${lines} duplicated lines, budget is ${existing.duplicatedLines} — extract the shared code instead of copying it (\`--list\` shows the largest clones)`);
    process.exit(1);
}
if (lines < existing.duplicatedLines) {
    console.log(`✅ ${lines} duplicated lines, under the budget of ${existing.duplicatedLines}. Run \`node scripts/duplication-ratchet.mjs --update\` to lower it.`);
} else {
    console.log(`➖ ${lines} duplicated lines, at budget`);
}
