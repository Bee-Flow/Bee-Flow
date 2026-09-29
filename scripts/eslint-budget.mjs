#!/usr/bin/env node
/**
 * ESLint warning budget — a ratchet, not a threshold.
 *
 * agent-hub carries thousands of warnings under rules kept at 'warn' so the
 * tree could get a lint config at all; server carries a few hundred. A gate
 * on "zero warnings" would be red from day one, and a gate that is always red
 * is switched off within a fortnight. So each package commits the highest
 * warning count it may carry (<package>/.eslint-budget.json), CI fails when a
 * change raises it, and `--update` lowers it after a clean-up. It never raises
 * the budget: that is a deliberate edit with a reason in the commit message.
 *
 * Errors are not budgeted; one error fails, as `eslint` itself would.
 *
 * Usage:
 *   node scripts/eslint-budget.mjs <package>             gate (runs eslint)
 *   node scripts/eslint-budget.mjs <package> --update    lower the budget
 *   node scripts/eslint-budget.mjs <package> --report r.json   count from an
 *                                             existing `eslint -f json` report
 *
 * eslint runs as `node <package>/node_modules/eslint/bin/eslint.js`, not
 * through node_modules/.bin: on Windows that is eslint.cmd, and Node refuses
 * to start a .cmd without a shell since the CVE-2024-27980 fix (EINVAL on
 * 18.20.2+, 20.12.2+ and 22), so the gate could not run there at all.
 *
 * It passes `--concurrency <n>` when the package's eslint has the flag
 * (9.34.0 and later): n is the CPUs this process may use, capped at
 * MAX_WORKERS, and no flag at all on one CPU. Not `auto`: eslint's auto is
 * half the CPUs and turns a single worker into none, so on a 2-vCPU CI
 * runner it changes nothing. Measured on agent-hub with 2 CPUs: 246-271 s
 * with auto or no flag, 170-176 s with 2 workers, identical findings.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The first eslint with --concurrency; an older one rejects the flag. */
export const CONCURRENCY_SINCE = '9.34.0';

/** Each eslint worker holds its own copy of the config and parsers (~1.2 GB on agent-hub). */
export const MAX_WORKERS = 4;

/** eslint's own JS entry in a package, to run with node: no .bin shim, no shell. */
export function eslintEntry(pkgDir) {
    return path.join(pkgDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
}

/** The version of the eslint installed in a package, or null. */
export function eslintVersion(pkgDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(pkgDir, 'node_modules', 'eslint', 'package.json'), 'utf8')).version ?? null;
    } catch {
        return null;
    }
}

/** Is `version` at least `min`? Compares major.minor.patch; anything unreadable is no. */
export function atLeast(version, min) {
    const parse = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number);
    const [a, b] = [parse(version), parse(min)];
    if (!a || !b) return false;
    const i = a.findIndex((n, k) => n !== b[k]);
    return i === -1 || a[i] > b[i];
}

/** The arguments the gate runs eslint with, for the eslint `version` installed and `cpus` usable. */
export function eslintArgs(version, cpus = availableParallelism()) {
    const workers = Math.min(cpus, MAX_WORKERS);
    const parallel = atLeast(version, CONCURRENCY_SINCE) && workers >= 2;
    return ['.', '-f', 'json', ...(parallel ? ['--concurrency', String(workers)] : [])];
}

function runEslint(pkg, dir) {
    const entry = eslintEntry(dir);
    if (!fs.existsSync(entry)) {
        console.error(`eslint-budget: ${path.relative(ROOT, entry)} not found — run npm ci in ${pkg} first`);
        process.exit(2);
    }
    try {
        return execFileSync(process.execPath, [entry, ...eslintArgs(eslintVersion(dir))], {
            cwd: dir,
            encoding: 'utf8',
            maxBuffer: 512 * 1024 * 1024,
        });
    } catch (e) {
        // eslint exits 1 when it reports errors; the JSON on stdout is still the report.
        if (e.stdout) return e.stdout;
        throw e;
    }
}

function main(args) {
    const pkg = args.find((a) => !a.startsWith('--'));
    if (!pkg) {
        console.error('eslint-budget: usage: node scripts/eslint-budget.mjs <package> [--update] [--report <file>]');
        process.exit(2);
    }
    const update = args.includes('--update');
    const reportAt = args.indexOf('--report');
    const reportFile = reportAt === -1 ? null : args[reportAt + 1];

    const dir = path.resolve(ROOT, pkg);
    const budgetFile = path.join(dir, '.eslint-budget.json');

    const raw = reportFile ? fs.readFileSync(path.resolve(reportFile), 'utf8') : runEslint(pkg, dir);
    const report = JSON.parse(raw);
    const counts = { errors: 0, warnings: 0 };
    for (const file of report) {
        counts.errors += file.errorCount;
        counts.warnings += file.warningCount;
    }

    if (counts.errors > 0) {
        console.error(`❌ ${pkg}: ${counts.errors} eslint error(s) — errors are never budgeted; run eslint in ${pkg} to see them`);
        process.exit(1);
    }

    const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;

    if (update || !existing) {
        const next = {
            _comment: `Highest eslint warning count ${pkg} may carry. Lower it with \`node scripts/eslint-budget.mjs ${pkg} --update\` after a clean-up; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            warnings: existing ? Math.min(counts.warnings, existing.warnings) : counts.warnings,
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${next.warnings} warnings (measured ${counts.warnings})`);
        process.exit(0);
    }

    if (counts.warnings > existing.warnings) {
        console.error(`❌ ${pkg}: ${counts.warnings} eslint warnings, budget is ${existing.warnings} — fix the ${counts.warnings - existing.warnings} new one(s) rather than raising the budget`);
        process.exit(1);
    }
    if (counts.warnings < existing.warnings) {
        console.log(`✅ ${pkg}: ${counts.warnings} warnings, under the budget of ${existing.warnings}. Run \`node scripts/eslint-budget.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: ${counts.warnings} warnings, at budget`);
    }
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    main(process.argv.slice(2));
}
