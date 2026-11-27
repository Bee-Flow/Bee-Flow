// @typecheck strict
/**
 * Every EXPORTED advisory-lock key or name is unique.
 *
 * Two jobs on one key silently starve each other: whichever replica takes the
 * lock first runs ITS pass, and the other job skips the tick as if another
 * replica owned it (isoEvidenceCollector and the Meet import discovery once
 * shared 0xBEEF10A this way). This test collects every export named
 * `*LOCK_KEY` (a number for `pg_try_advisory_lock($1)`) or `*LOCK_NAME` (a
 * string for `hashtext($1)`, see core/scheduling/namedLock.js) from every module in jobs/
 * plus the lock holders outside it, and fails on a repeat.
 *
 * Module-private keys are NOT covered (they are not reachable without a
 * source-text test): the six in core/automationRunner/scheduler/passes.js
 * (0xBEEF105-0xBEEF107, 0xBEEF10E, 0xBEEF112, 0xBEEF113), and those of
 * usageOpenObservePush, opsMetricsPush, projects/taskDueNotifier,
 * monitoringRetention, memoryEmbeddingBackfill, compliance/isoEvidenceCollector,
 * learningNudge and core/kb/embeddingMigration. Export one to bring it under
 * this test. A hashtext() name and a number share one key space; a collision
 * between the two kinds is not checked here (hashtext is Postgres-side).
 *
 * Run: cd server && node --test jobs/lib/advisoryLockKeys.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listTreeDir, treePath, toTreePath } = require('../../moduleRoots.cjs');

// Lock holders outside jobs/ that export their key (tree paths).
const OUTSIDE_JOBS = [
    'compliance/scheduler.js',
    'core/automationRunner/scheduler/gmeetImportTick.js',
];

function lockExports() {
    // jobs/ of every root (a job moves with its module), plus the holders outside it.
    const jobs = listTreeDir('jobs').filter((e) => e.name.endsWith('.js') && !e.name.endsWith('.test.js'));
    assert.ok(jobs.some((e) => e.moduleId === null), 'no job file found in the core root: the listing is blind');
    const files = jobs.map((e) => e.abs).concat(OUTSIDE_JOBS.map((f) => treePath(f)));
    const found = [];
    for (const file of files) {
        const mod = require(file);
        for (const [name, value] of Object.entries(mod || {})) {
            if (/LOCK_(KEY|NAME)$/.test(name)) found.push({ where: `${toTreePath(file)}#${name}`, value });
        }
    }
    return found;
}

/**
 * lockExports() over the WHOLE tree: the key space is shared by every module, so in core mode
 * (BEEFLOW_HIDE_MODULES, where a hidden module's files do not load) the same function runs in a
 * child process with every module visible; otherwise in this process.
 * @returns {{ where: string, value: unknown }[]}
 */
function treeLockExports() {
    if (!process.env.BEEFLOW_HIDE_MODULES) return lockExports();
    const server = path.resolve(__dirname, '..', '..');
    const code = [
        "const assert = require('node:assert');",
        "const { listTreeDir, treePath, toTreePath } = require(process.argv[1]);",
        `const OUTSIDE_JOBS = ${JSON.stringify(OUTSIDE_JOBS)};`,
        lockExports.toString(),
        'process.stdout.write(`\\n@@result@@${JSON.stringify(lockExports())}`);',
        'process.exit(0);', // a job file may hold a timer
    ].join('\n');
    const env = { ...process.env };
    for (const key of ['BEEFLOW_HIDE_MODULES', 'NODE_TEST_CONTEXT']) delete env[key];
    const r = spawnSync(process.execPath, ['--require', path.join(server, 'moduleRoots.cjs'), '-e', code, path.join(server, 'moduleRoots.cjs')],
        { cwd: server, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('@@result@@') + '@@result@@'.length)); // after anything a file logged
}

test('every exported advisory-lock key and name is used by exactly one module', () => {
    const found = treeLockExports();
    // The known exports, so a rename that drops one out of the scan is noticed.
    assert.ok(found.length >= 10, `expected at least 10 exported locks, found ${found.length}`);
    for (const { where, value } of found) {
        assert.ok(typeof value === 'number' ? Number.isSafeInteger(value) : typeof value === 'string' && value.length > 0,
            `${where} is not a usable lock key: ${String(value)}`);
    }
    const byValue = new Map();
    for (const { where, value } of found) {
        const k = `${typeof value}:${value}`;
        byValue.set(k, [...(byValue.get(k) || []), where]);
    }
    const dupes = [...byValue.entries()].filter(([, w]) => w.length > 1);
    assert.deepStrictEqual(dupes, [], `advisory lock used twice: ${JSON.stringify(dupes)}`);
});
