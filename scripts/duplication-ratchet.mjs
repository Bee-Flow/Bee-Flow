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
 * Two budgets, production and test: a clone whose two ends are both test code
 * (see isTestFile) counts as test, every other clone as production, so the two
 * add up to jscpd's total. Without the split, a repetitive test file written
 * today hides a production clone added tomorrow (and the other way round).
 * Each number may only fall; --update lowers each on its own.
 *
 * Generated files (the shared mirror targets, *.generated.*, the editor
 * bundles, en-defaults.js, ...) are in the ignore list of .jscpd.json:
 * duplication nobody writes. duplication-ratchet.test.mjs fails when a
 * shared-mirror manifest target is not ignored there.
 *
 * Usage:
 *   node scripts/duplication-ratchet.mjs                    gate (runs jscpd; root `npm ci` first)
 *   node scripts/duplication-ratchet.mjs --update           lower the budget
 *   node scripts/duplication-ratchet.mjs --report <file>    read an existing jscpd JSON report
 *   node scripts/duplication-ratchet.mjs --list             the largest clones per group, biggest first
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Test code: test/spec files, test folders, test kits and fixtures (JS/TS and Python). */
export const TEST_FILE = /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|testUtils|test-?kit|e2e)\/|\.(test|spec|testkit|fixture)\.[cm]?[jt]sx?$|(^|\/)testKit\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;
export const isTestFile = (name) => TEST_FILE.test(String(name).replaceAll('\\', '/'));

/** The group a clone counts in: test only when both ends are test code. */
export const groupOf = (clone) => (isTestFile(clone.firstFile?.name) && isTestFile(clone.secondFile?.name) ? 'test' : 'production');
export const GROUPS = ['production', 'test'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = path.join(ROOT, '.jscpd-ratchet.json');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
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
    const total = report?.statistics?.total?.duplicatedLines;
    if (typeof total !== 'number' || !Array.isArray(report.duplicates)) {
        console.error('duplication-ratchet: the report has no statistics.total.duplicatedLines or no duplicates list');
        process.exit(2);
    }
    const measured = { production: 0, test: 0 };
    for (const c of report.duplicates) measured[groupOf(c)] += c.lines || 0;
    const summed = measured.production + measured.test;
    if (summed !== total) {
        // jscpd's total is the sum of clone lengths; a mismatch means the report
        // changed shape, and a split that does not add up is not a measurement.
        console.error(`duplication-ratchet: the clones add up to ${summed} lines, jscpd's total says ${total}`);
        process.exit(2);
    }

    if (list) {
        for (const g of GROUPS) {
            console.log(`${g} (${measured[g]} duplicated lines):`);
            const clones = report.duplicates.filter((c) => groupOf(c) === g).sort((a, b) => b.lines - a.lines).slice(0, 25);
            for (const c of clones) {
                console.log(`${String(c.lines).padStart(5)}  ${c.firstFile.name}:${c.firstFile.start} ↔ ${c.secondFile.name}:${c.secondFile.start}`);
            }
            console.log('');
        }
    }

    const existing = fs.existsSync(BUDGET_FILE) ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) : null;
    const has = (g) => typeof existing?.[g] === 'number';

    if (update || !existing || !GROUPS.every(has)) {
        const next = {
            _comment: 'Highest number of duplicated lines (jscpd, .jscpd.json) the repository may carry, per group: production (any clone with a non-test end) and test (both ends test code). Lower them with `node scripts/duplication-ratchet.mjs --update` after removing clones; raising one is a deliberate edit that belongs in a commit message with a reason.',
            _generated: new Date().toISOString().slice(0, 10),
        };
        for (const g of GROUPS) next[g] = has(g) ? Math.min(measured[g], existing[g]) : measured[g];
        fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to .jscpd-ratchet.json: production ${next.production}, test ${next.test} duplicated lines (measured ${measured.production} / ${measured.test})`);
        process.exit(0);
    }

    let failed = false;
    for (const g of GROUPS) {
        const budget = existing[g];
        if (measured[g] > budget) {
            console.error(`❌ ${g}: ${measured[g]} duplicated lines, budget is ${budget} — extract the shared code instead of copying it (\`--list\` shows the largest clones)`);
            failed = true;
        } else if (measured[g] < budget) {
            console.log(`✅ ${g}: ${measured[g]} duplicated lines, under the budget of ${budget}. Run \`node scripts/duplication-ratchet.mjs --update\` to lower it.`);
        } else {
            console.log(`➖ ${g}: ${measured[g]} duplicated lines, at budget`);
        }
    }
    if (failed) process.exit(1);
}
