#!/usr/bin/env node
// @typecheck strict
/**
 * Journey runner — the entry point behind `npm run test:journeys`.
 *
 * The journeys (journeys/*.journey.test.js) are user stories across several
 * requests against the real server in-process (journeys/journeyWorld.testkit.js).
 * They are not part of `npm test` (scripts/run-tests.mjs skips journeys/): ci.yml
 * runs them in a job of their own, so they cost the main suite nothing.
 *
 * What it does:
 *   1. Builds the PGlite boot-ladder template once, before any journey starts.
 *      Every journey loads it (testUtils/pgliteTemplate.js ladderPglite); a
 *      missing one would otherwise be built by every journey process at once.
 *   2. Runs every journey file with `node --test`, each file in its own process
 *      (node's default), with the feature-module preload run-tests.mjs uses.
 *
 * Usage:
 *   npm run test:journeys                     # every journey
 *   node scripts/run-journeys.mjs accounts    # the journeys whose file name contains "accounts"
 *
 * No --test-force-exit, for the reason in run-tests.mjs: a journey that keeps
 * the event loop open is a journey that does not close its world, and the run
 * must say so rather than end early. JOURNEY_TIMEOUT_MS (default 600000, 0 =
 * none) bounds one file.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNEYS = path.join(SERVER_DIR, 'journeys');

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the fixed test value of a journey run on an in-process database, never a deployment's secret
process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

const filters = process.argv.slice(2);
const files = readdirSync(JOURNEYS)
    .filter((f) => f.endsWith('.journey.test.js'))
    .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
    .sort()
    .map((f) => path.join('journeys', f));
if (files.length === 0) {
    process.stderr.write(`run-journeys: no journey matches ${filters.join(', ') || '(none found)'}\n`);
    process.exit(1);
}

// 1. The ladder template, built here (in a child process, as pgliteTemplate does) when it is stale.
const require = createRequire(import.meta.url);
const { ladderPglite } = require(path.join(SERVER_DIR, 'testUtils', 'pgliteTemplate.js'));
const started = Date.now();
await ladderPglite().close();
process.stdout.write(`run-journeys: ladder template ready in ${Date.now() - started} ms\n`);

// 2. The journeys.
const timeout = Number(process.env.JOURNEY_TIMEOUT_MS ?? 600_000);
const res = spawnSync(process.execPath, [
    '--require', path.join(SERVER_DIR, 'testUtils', 'registerFeatures.js'),
    '--test',
    ...(timeout > 0 ? [`--test-timeout=${timeout}`] : []),
    ...files,
], { cwd: SERVER_DIR, stdio: 'inherit', env: process.env });
process.stdout.write(`run-journeys: ${files.length} journey file(s) in ${Date.now() - started} ms\n`);
process.exit(res.status ?? 1);
