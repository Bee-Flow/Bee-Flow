#!/usr/bin/env node
// @typecheck strict
/**
 * Postgres test runner: the entry point behind `npm run test:postgres`.
 *
 * A handful of tests go through the real db.js pool to a real Postgres
 * (CORE_DATABASE_URL): the atomic claims (FOR UPDATE SKIP LOCKED), the
 * reapers, a session advisory lock between two connections. PGlite is one
 * connection and cannot show those. In `npm test` these files skip themselves
 * (no database there); ci.yml's `server-postgres` job runs them here against
 * a Postgres service container.
 *
 * What it does:
 *   1. Refuses to start without CORE_DATABASE_URL: db.js's development default
 *      would otherwise aim the tests at whatever listens on localhost:5432.
 *   2. Sets REQUIRE_POSTGRES=1, so an unreachable database fails a file
 *      instead of skipping it (testUtils/requirePostgres.js).
 *   3. Runs the files ONE AT A TIME (--test-concurrency=1): they share one
 *      database, and a claim takes whatever is due, another file's rows too.
 *
 * It does not create the schema: run `npm run db:migrate` against the same
 * database first (the job does). A store creates its own tables on first use,
 * but not the ones those refer to (kbSources reads `projects`, the automation
 * organisation backfill reads `users`).
 *
 * A new test that needs a real Postgres is added to FILES below, by its tree
 * path: it is found in server/ or in the module root it moved to
 * (scripts/lib/roots.mjs). A file listed here that no root has fails the run.
 * Like run-tests.mjs, the run gets the module-roots resolver through NODE_OPTIONS.
 *
 * Usage:
 *   export CORE_DATABASE_URL=postgresql://user@127.0.0.1:5432/disposable_db
 *   npm run db:migrate && npm run test:postgres
 *   node scripts/run-postgres-tests.mjs claim     # the files whose path contains "claim"
 *
 * POSTGRES_TEST_TIMEOUT_MS (default 120000, 0 = none) bounds one file.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTreePath } from '../../scripts/lib/roots.mjs';
import { resolverEnv } from './testScope.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER = path.join(SERVER_DIR, 'moduleRoots.cjs');

/** The tests that need a real Postgres, by tree path (relative to their root). */
export const FILES = [
    // Atomic claim, release and the stuck-run reaper of scheduled automations.
    'stores/automationStore.claim.test.js',
    // Additional schedule triggers: claim and advance.
    'stores/automationStore.schedules.test.js',
    'stores/automationStore.builderSessionSync.test.js',
    // Upload/ingest state machine: exclusive ingest claims, the quota sum.
    'stores/datasetFileStore.test.js',
    // Knowledge-base sources: claimDue, stuck and stale claims, cascades.
    'stores/kbSources.test.js',
    // Cowork run history: one attempt, one closed row.
    'stores/coworkStore.test.js',
    // Creates and drops a database of its own (DOCUMENT_TEST_DATABASE_URL).
    'stores/documentStore.integration.test.js',
    // The job locks' shared session, with two pools standing in for two replicas.
    'core/scheduling/lockSession.pg.test.js',
];
// Not here on purpose:
//   core/automationRunner/safety.egress.test.js (excluded from `npm test`,
//     needs-infra) passes against a real Postgres, but its first test gives
//     logEgress 200 ms and the first run after a fresh migration took 291 ms:
//     in a required job that is a flake.
//   stores/memoryRetrieval.integration.test.js needs pgvector and its own
//     MEMORY_TEST_DATABASE_URL; it was not run where this list was put together.

/**
 * @param {string[]} filters path fragments; none selects every file
 * @returns {string[]}
 */
export function selectFiles(filters, files = FILES) {
    return files.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));
}

/**
 * The argument `node --test` gets for a tree path: the tree path itself for a file in
 * server/ (the cwd), the absolute path for a file in a module root.
 * @param {string} treePath
 * @param {(treePath: string) => string | null} [resolve] the absolute path in the root that has it
 */
export function fileArg(treePath, resolve = (p) => resolveTreePath('server', p)) {
    const abs = resolve(treePath);
    return abs && !abs.startsWith(SERVER_DIR + path.sep) ? abs : treePath;
}

/**
 * Why the run cannot start, or null when it can.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} files the selection
 * @param {(file: string) => boolean} exists
 * @returns {string | null}
 */
export function refusal(env, files, exists) {
    if (!env.CORE_DATABASE_URL) {
        return 'CORE_DATABASE_URL is not set. Point it at a disposable Postgres (and run `npm run db:migrate` against it first).';
    }
    if (files.length === 0) return 'no file matches';
    const missing = files.filter((f) => !exists(f));
    if (missing.length > 0) return `listed in FILES but not on disk: ${missing.join(', ')}`;
    return null;
}

/**
 * @param {string[]} files
 * @param {number} timeoutMs 0 = none
 * @returns {string[]} the `node` arguments of the run
 */
export function nodeArgs(files, timeoutMs) {
    return [
        '--require', path.join(SERVER_DIR, 'testUtils', 'registerFeatures.js'),
        '--test',
        '--test-concurrency=1',
        ...(timeoutMs > 0 ? [`--test-timeout=${timeoutMs}`] : []),
        ...files,
    ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const files = selectFiles(process.argv.slice(2));
    const why = refusal(process.env, files, (f) => resolveTreePath('server', f) !== null);
    if (why) {
        process.stderr.write(`run-postgres-tests: ${why}\n`);
        process.exit(1);
    }
    const env = resolverEnv({
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'test',
        REQUIRE_POSTGRES: '1',
        // Throwaway values, as in run-tests.mjs: several stores refuse to load without them.
        SESSION_SECRET: process.env.SESSION_SECRET ?? 'ci-session-secret-value-at-least-32-chars-long', // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the fixed test value of a run against a disposable database, the same one run-tests.mjs sets
        MASTER_ENCRYPTION_KEY: process.env.MASTER_ENCRYPTION_KEY ?? 'ci-master-encryption-key-for-tests-only!!',
        DOCUMENT_TEST_DATABASE_URL: process.env.DOCUMENT_TEST_DATABASE_URL ?? process.env.CORE_DATABASE_URL,
    }, { preload: RESOLVER, hide: null });
    const started = Date.now();
    const res = spawnSync(process.execPath, nodeArgs(files.map((f) => fileArg(f)), Number(process.env.POSTGRES_TEST_TIMEOUT_MS ?? 120_000)), { cwd: SERVER_DIR, stdio: 'inherit', env });
    process.stdout.write(`run-postgres-tests: ${files.length} file(s) in ${Date.now() - started} ms\n`);
    process.exit(res.status ?? 1);
}
