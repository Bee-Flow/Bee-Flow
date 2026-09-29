#!/usr/bin/env node
/**
 * Coverage ratchet — the floor under each suite's line coverage, which may
 * only rise.
 *
 * Every suite writes a machine-readable total: istanbul's json-summary
 * (vitest, jest, and c8 for the server: `coverage/coverage-summary.json`,
 * `total.lines.pct`) or coverage.py's JSON (pytest-cov `--cov-report=json`,
 * `totals.percent_covered`). This script reads that total and compares it with
 * the floor the package commits in `<package>/.coverage-ratchet.json`.
 *
 * The floor sits one point under the measurement it was taken from. Line
 * coverage moves by a few hundredths between runs of an unchanged tree (a
 * branch taken on a timer, a retry path); a floor at the exact figure would
 * turn that into red builds nobody can fix. One point is far above that noise
 * and far below what a PR that drops a tested module costs.
 *
 * Usage:
 *   node scripts/coverage-ratchet.mjs <package> [--summary <file>]            gate
 *   node scripts/coverage-ratchet.mjs <package> [--summary <file>] --update   raise the floor
 *
 * `--summary` defaults to <package>/coverage/coverage-summary.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const update = args.includes('--update');
const summaryAt = args.indexOf('--summary');
const summaryArg = summaryAt >= 0 ? args[summaryAt + 1] : null;
const pkg = args.find((a, i) => !a.startsWith('--') && (summaryAt < 0 || i !== summaryAt + 1));

if (!pkg || (summaryAt >= 0 && !summaryArg)) {
    console.error('coverage-ratchet: usage: node scripts/coverage-ratchet.mjs <package> [--summary <file>] [--update]');
    process.exit(2);
}

const dir = path.resolve(ROOT, pkg);
const summaryFile = summaryArg ? path.resolve(ROOT, summaryArg) : path.join(dir, 'coverage', 'coverage-summary.json');
const floorFile = path.join(dir, '.coverage-ratchet.json');

if (!fs.existsSync(summaryFile)) {
    console.error(`coverage-ratchet: ${path.relative(ROOT, summaryFile)} not found — run the suite with coverage first. A missing report is not a pass.`);
    process.exit(2);
}

/** Line coverage in percent, from either summary format. */
function linePct(summary) {
    if (typeof summary?.total?.lines?.pct === 'number') return summary.total.lines.pct;
    if (typeof summary?.totals?.percent_covered === 'number') return summary.totals.percent_covered;
    return null;
}

const pct = linePct(JSON.parse(fs.readFileSync(summaryFile, 'utf8')));
if (pct === null) {
    console.error(`coverage-ratchet: ${path.relative(ROOT, summaryFile)} has no line total (expected total.lines.pct or totals.percent_covered).`);
    process.exit(2);
}

const shown = pct.toFixed(2);
const candidate = Math.max(0, Math.floor(pct) - 1);
const existing = fs.existsSync(floorFile) ? JSON.parse(fs.readFileSync(floorFile, 'utf8')) : null;

if (update || !existing) {
    const lines = existing ? Math.max(existing.lines, candidate) : candidate;
    const next = {
        _comment: `Lowest line coverage (percent) ${pkg} may report. Raise it with \`node scripts/coverage-ratchet.mjs ${pkg} --update\` after adding tests; lowering it is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        lines,
    };
    fs.writeFileSync(floorFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Floor written to ${path.relative(ROOT, floorFile)}: ${lines}% (measured ${shown}%)`);
    process.exit(0);
}

if (pct < existing.lines) {
    console.error(`❌ ${pkg}: line coverage ${shown}% is under the floor of ${existing.lines}% — add tests for the code this change brought in, rather than lowering the floor`);
    process.exit(1);
}
if (candidate > existing.lines) {
    console.log(`✅ ${pkg}: line coverage ${shown}%, floor ${existing.lines}%. Run \`node scripts/coverage-ratchet.mjs ${pkg} --update\` to raise it to ${candidate}%.`);
} else {
    console.log(`➖ ${pkg}: line coverage ${shown}%, floor ${existing.lines}%`);
}
