#!/usr/bin/env node
/**
 * Server test runner — the single entry point behind `npm test`.
 *
 * What it does:
 *   1. Collects every colocated *.test.js under server/ (skipping node_modules),
 *      the same set `find . -name '*.test.js' -not -path './node_modules/*'` yields.
 *   2. Subtracts the files listed in scripts/test-exclusions.json (each with a
 *      bucket and an honest reason). If an excluded file no longer exists the
 *      run FAILS — a rename must update the exclusion list, so stale entries
 *      can never silently shrink coverage.
 *   3. Runs each remaining file in its own `node --test` process, pooled at
 *      the machine's parallelism, and adds the per-file tallies up.
 *
 * Why one process per file and no --test-force-exit: that flag was dropping
 * results, quietly and by a different amount every run. The measurements and
 * the reasoning are in the Run section below — it is the difference between a
 * gate that can fail and one that only looks like it can.
 *
 * Usage:
 *   npm test                                # or: node scripts/run-tests.mjs
 *   node scripts/run-tests.mjs --list-excluded   # print the exclusion table
 *   node scripts/run-tests.mjs --coverage        # also write coverage/ (lcov +
 *                                                # json-summary) from every file
 *
 * Extra CLI arguments are passed through to `node --test` (e.g.
 * `node scripts/run-tests.mjs --test-name-pattern=canEdit`), except the
 * reporter flags: the runner reads each file's TAP summary itself, so it
 * refuses `--test-reporter` and `--test-reporter-destination` (see Run).
 */

import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUSIONS_FILE = path.join(SERVER_DIR, 'scripts', 'test-exclusions.json');

// ── Environment defaults ────────────────────────────────────────────────────
// The suite is designed to run without infrastructure, but the crypto/session
// modules refuse to load without these variables. The fallbacks below are the
// same throwaway values the server job in .github/workflows/ci.yml uses — they are NOT
// secrets, and they are only applied under NODE_ENV=test when the variable is
// unset, so a deliberately configured environment always wins.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
if (process.env.NODE_ENV === 'test') {
    process.env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long';
    process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';
}

// ── Exclusion list ──────────────────────────────────────────────────────────
const VALID_BUCKETS = new Set(['needs-infra', 'needs-fixture', 'failing']);
const { exclusions } = JSON.parse(readFileSync(EXCLUSIONS_FILE, 'utf8'));

const badBucket = exclusions.find((e) => !VALID_BUCKETS.has(e.bucket));
if (badBucket) {
    console.error(`Invalid bucket "${badBucket.bucket}" for ${badBucket.file} in ${EXCLUSIONS_FILE} — use one of: ${[...VALID_BUCKETS].join(', ')}`);
    process.exit(1);
}

const stale = exclusions.filter((e) => !existsSync(path.join(SERVER_DIR, e.file)));
if (stale.length > 0) {
    for (const e of stale) {
        console.error(`Excluded test file no longer exists: ${e.file} — update scripts/test-exclusions.json (was excluded as "${e.bucket}": ${e.reason})`);
    }
    process.exit(1);
}

if (process.argv.includes('--list-excluded')) {
    const width = Math.max(...exclusions.map((e) => e.file.length));
    for (const bucket of [...VALID_BUCKETS]) {
        const rows = exclusions.filter((e) => e.bucket === bucket);
        if (rows.length === 0) continue;
        console.log(`\n${bucket} (${rows.length}):`);
        for (const e of rows) console.log(`  ${e.file.padEnd(width)}  ${e.reason}`);
    }
    console.log(`\n${exclusions.length} file(s) excluded. Remove entries as they are fixed — this list should only get shorter.`);
    process.exit(0);
}

// ── Collect test files ──────────────────────────────────────────────────────
function collectTestFiles(dir, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (rel === 'node_modules') continue; // top-level only, matching the old find(1) invocation
            out.push(...collectTestFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs'))) {
            out.push(rel);
        }
    }
    return out;
}

const excludedSet = new Set(exclusions.map((e) => e.file));
const allFiles = collectTestFiles(SERVER_DIR).sort();
const runFiles = allFiles.filter((f) => !excludedSet.has(f));

console.log(`Running ${runFiles.length} of ${allFiles.length} test files (${excludedSet.size} excluded — see scripts/test-exclusions.json).`);

// ── Run ─────────────────────────────────────────────────────────────────────
// WHY EACH FILE GETS ITS OWN PROCESS, AND WHY --test-force-exit IS GONE.
//
// The runner used to hand every file to one `node --test --test-force-exit`.
// That flag ends the process once the runner believes the known tests are
// done, and results that had not been reported by then are simply dropped —
// silently, with the summary still reading `# fail 0` and `# cancelled 0`.
// It is not a rounding error. Measured on this tree:
//
//     core/agentRuntime/toolPolicy.test.js       23 with the flag, 72 without
//     projects/packaging/install.test.js         45 with the flag, 68 without
//     core/automationRunner/execHttpRequest.js   39 with the flag, 41 without
//     25 files from core/automationRunner       367 with the flag, 430 without
//
// and two full runs on one unchanged tree reported 16.945 and 16.908 tests.
// A gate that silently drops a different slice of its tests every run cannot
// be relied on to go red, and a check that cannot fail is not a check.
//
// Simply removing the flag does not work either: a handful of files finish
// their tests and then keep the event loop alive, and without the flag the
// whole run hangs with no summary at all — verified here, the full suite
// never finished.
//
// So the two jobs are separated. Each file is run on its own, WITHOUT the
// flag, so nothing is cut short; a file that hangs hits its own timeout and is
// named, instead of taking the run's results down with it. That also makes the
// totals deterministic, which is what lets them be quoted.
const passthrough = process.argv.slice(2).filter((a) => a !== '--list-excluded' && a !== '--coverage');

// COVERAGE, AND WHY IT IS NOT A PASSTHROUGH EITHER. With one process per file,
// any single report destination is rewritten by each file in turn (see the
// reporter note below). V8 itself does it right: with NODE_V8_COVERAGE set,
// every node process — the `node --test` child and the process it spawns for
// the file — writes its own uniquely named dump into that directory. After the
// run, c8 merges all of them into one report. A file that hangs is SIGKILLed
// and leaves no dump; its lines read as uncovered, which is the honest answer.
const coverage = process.argv.includes('--coverage');
const coverageTmp = coverage ? mkdtempSync(path.join(tmpdir(), 'server-v8-coverage-')) : null;
const childEnv = coverage ? { ...process.env, NODE_V8_COVERAGE: coverageTmp } : process.env;

// The reporter is not a passthrough option, because the tallies below are read
// from each child's TAP output (`# tests N`) and every child gets the same
// arguments. ci.yml once passed `--test-reporter=spec` plus an lcov file
// destination: spec prints `ℹ tests N`, so every file came back NO SUMMARY
// and the job went red on a green suite, and the one lcov file was rewritten
// by each child in turn, leaving the coverage of whichever file finished last.
// Refused up front, before anything runs, so neither can come back quietly.
const reporterFlags = passthrough.filter((a) => /^--test-reporter(-destination)?(=|$)/.test(a));
if (reporterFlags.length > 0) {
    console.error(
        `run-tests: ${reporterFlags.join(' ')} refused — the runner reads each file's TAP summary, ` +
            'so a different reporter reads as "reported nothing" and a file destination is overwritten by every file in turn.',
    );
    process.exit(1);
}

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || availableParallelism();
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS ?? 180_000);

const COUNTERS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const totals = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
const failedFiles = [];
const hungFiles = [];
const noSummaryFiles = [];
let done = 0;

/** Pull the reporter's own tallies out of a finished file's output. */
function summaryOf(text) {
    const got = {};
    for (const key of COUNTERS) {
        const m = new RegExp(`^# ${key} (\\d+)`, 'm').exec(text);
        if (m) got[key] = Number(m[1]);
    }
    return got.tests === undefined ? null : got;
}

function runFile(file) {
    return new Promise((resolve) => {
        // `detached` makes the child a process-group leader so the whole group
        // can be signalled at once. That is not a nicety: `node --test` spawns
        // a further process per test file, so killing only the direct child
        // leaves the one that is actually wedged running — orphaned, at 100%
        // of a core, forever. Six of those accumulated on this box from the
        // runner's own `wedged.test.mjs` fixture before anyone noticed; the
        // load average reached 26 on four cores and every suite crawled.
        const child = spawn(
            process.execPath,
            ['--test', ...passthrough, file],
            { cwd: SERVER_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        let out = '';
        let timedOut = false;
        /** SIGKILL the child AND anything it spawned. */
        const killTree = () => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
            try { child.kill('SIGKILL'); } catch { /* already reaped */ }
        };
        const timer = setTimeout(() => { timedOut = true; killTree(); }, FILE_TIMEOUT_MS);
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { out += b; });
        child.on('error', (e) => { out += `\nfailed to start: ${e.message}\n`; });
        child.on('close', (code) => {
            clearTimeout(timer);
            done += 1;
            const summary = timedOut ? null : summaryOf(out);

            if (timedOut) {
                // Its tests may well all pass; the problem is that it never
                // lets go. Left unnamed, this is what the old flag was hiding.
                hungFiles.push(file);
                process.stdout.write(`\nHUNG  ${file} — still running after ${Math.round(FILE_TIMEOUT_MS / 1000)}s. A test in it keeps the event loop alive.\n`);
            } else if (!summary) {
                noSummaryFiles.push(file);
                process.stdout.write(`\nNO SUMMARY  ${file} (exit ${code}) — it did not get as far as reporting.\n${out}\n`);
            } else {
                for (const key of COUNTERS) totals[key] += summary[key] ?? 0;
                if (summary.fail > 0 || summary.cancelled > 0 || code !== 0) {
                    failedFiles.push(file);
                    process.stdout.write(`\nFAIL  ${file}\n${out}\n`);
                }
            }
            if (done % 100 === 0 || done === runFiles.length) {
                process.stdout.write(`  ${done}/${runFiles.length} files\n`);
            }
            resolve();
        });
    });
}

/** A fixed pool: each worker takes the next file until there are none left. */
const queue = [...runFiles];
const started = Date.now();
await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
            await runFile(file);
        }
    }),
);

console.log('');
for (const key of COUNTERS) console.log(`# ${key} ${totals[key]}`);
console.log(`# files ${runFiles.length}`);
console.log(`# duration_ms ${Date.now() - started}`);

if (hungFiles.length > 0) {
    console.error(`\n${hungFiles.length} file(s) never exited — fix the open handle, do not paper over it:`);
    for (const f of hungFiles) console.error(`  ${f}`);
}
if (noSummaryFiles.length > 0) {
    console.error(`\n${noSummaryFiles.length} file(s) reported nothing:`);
    for (const f of noSummaryFiles) console.error(`  ${f}`);
}
if (failedFiles.length > 0) {
    console.error(`\n${failedFiles.length} file(s) failed:`);
    for (const f of failedFiles) console.error(`  ${f}`);
}

let coverageOk = true;
if (coverage) {
    // Include/exclude and the reporters live in .c8rc.json, so a local
    // `npx c8 report --temp-directory …` reads the same scope as CI.
    const c8 = spawnSync(
        process.execPath,
        [path.join(SERVER_DIR, 'node_modules', 'c8', 'bin', 'c8.js'), 'report', '--temp-directory', coverageTmp],
        { cwd: SERVER_DIR, stdio: 'inherit' },
    );
    rmSync(coverageTmp, { recursive: true, force: true });
    coverageOk = c8.status === 0;
    if (!coverageOk) console.error('\nc8 could not write the coverage report.');
}

const ok = failedFiles.length === 0 && hungFiles.length === 0 && noSummaryFiles.length === 0 && coverageOk;
process.exit(ok ? 0 : 1);
