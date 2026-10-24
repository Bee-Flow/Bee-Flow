// @typecheck
/**
 * Every EXPORTED advisory-lock key or name is unique.
 *
 * Two jobs on one key silently starve each other: whichever replica takes the
 * lock first runs ITS pass, and the other job skips the tick as if another
 * replica owned it (isoEvidenceCollector and the Meet import discovery once
 * shared 0xBEEF10A this way). This test collects every export named
 * `*LOCK_KEY` (a number for `pg_try_advisory_lock($1)`) or `*LOCK_NAME` (a
 * string for `hashtext($1)`, see ./namedLock.js) from every module in jobs/
 * plus the lock holders outside it, and fails on a repeat.
 *
 * Module-private keys are NOT covered (they are not reachable without a
 * source-text test): the six in core/automationRunner/scheduler/passes.js
 * (0xBEEF105-0xBEEF107, 0xBEEF10E, 0xBEEF112, 0xBEEF113), and those of
 * usageOpenObservePush, opsMetricsPush, projectTaskDueNotifier,
 * monitoringRetention, memoryEmbeddingBackfill, isoEvidenceCollector,
 * learningNudge and core/kb/embeddingMigration. Export one to bring it under
 * this test. A hashtext() name and a number share one key space; a collision
 * between the two kinds is not checked here (hashtext is Postgres-side).
 *
 * Run: cd server && node --test jobs/lib/advisoryLockKeys.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..');
const JOBS = path.join(SERVER, 'jobs');
// Lock holders outside jobs/ that export their key.
const OUTSIDE_JOBS = [
    'compliance/scheduler.js',
    'core/automationRunner/scheduler/gmeetImportTick.js',
];

function lockExports() {
    const files = fs.readdirSync(JOBS)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map((f) => path.join(JOBS, f))
        .concat(OUTSIDE_JOBS.map((f) => path.join(SERVER, f)));
    const found = [];
    for (const file of files) {
        const mod = require(file);
        for (const [name, value] of Object.entries(mod || {})) {
            if (/LOCK_(KEY|NAME)$/.test(name)) found.push({ where: `${path.relative(SERVER, file)}#${name}`, value });
        }
    }
    return found;
}

test('every exported advisory-lock key and name is used by exactly one module', () => {
    const found = lockExports();
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
