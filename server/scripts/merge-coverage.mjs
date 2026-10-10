#!/usr/bin/env node
/**
 * Merge the per-shard coverage of the sharded server run into one report.
 *
 * Each shard (`run-tests.mjs --shard i/n --coverage --coverage-json <dir>`)
 * leaves an istanbul `coverage-final.json` for the files IT ran, over the whole
 * source tree (.c8rc.json has `all: true`, so a file no shard touched is in
 * there as uncovered). This script adds them up: a line is covered when ANY
 * shard covered it. It then writes the reports .c8rc.json asks for, so
 * `coverage/coverage-summary.json` and `coverage/lcov.info` look exactly like
 * the ones of an unsharded run and scripts/coverage-ratchet.mjs reads them
 * unchanged.
 *
 * Usage: node scripts/merge-coverage.mjs --expect <n> <dir>...
 * Every <dir> must hold a non-empty coverage-final.json and there must be
 * exactly <n> of them: a shard that did not report would merge into a lower
 * number that reads as a coverage drop, or pass on part of the suite.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const args = process.argv.slice(2);
const expectAt = args.indexOf('--expect');
const expected = expectAt >= 0 ? Number(args[expectAt + 1]) : null;
const dirs = args.filter((a, i) => !a.startsWith('--') && i !== expectAt + 1);

if (!expected || dirs.length !== expected) {
    console.error(`merge-coverage: expected ${expected} shard directories, got ${dirs.length}. Usage: --expect <n> <dir>...`);
    process.exit(2);
}

const map = libCoverage.createCoverageMap({});
for (const dir of dirs) {
    const file = path.join(dir, 'coverage-final.json');
    if (!existsSync(file)) {
        console.error(`merge-coverage: ${file} is missing: that shard did not report coverage.`);
        process.exit(1);
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Object.keys(data).length === 0) {
        console.error(`merge-coverage: ${file} is empty.`);
        process.exit(1);
    }
    map.merge(data);
}

const rc = JSON.parse(readFileSync(path.join(SERVER_DIR, '.c8rc.json'), 'utf8'));
const reportsDir = path.resolve(SERVER_DIR, rc['reports-dir'] ?? 'coverage');
mkdirSync(reportsDir, { recursive: true });
const context = libReport.createContext({ dir: reportsDir, coverageMap: map, defaultSummarizer: 'nested' });
for (const name of rc.reporter ?? ['text-summary', 'lcov', 'json-summary']) reports.create(name).execute(context);
