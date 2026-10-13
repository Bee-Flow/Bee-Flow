/**
 * The ISO evidence sweep and the Google Meet auto-import discovery must not
 * share an advisory lock.
 *
 * Both are "one replica per tick" jobs guarded by a session advisory lock. They
 * used to take the SAME numeric key (0xBEEF10A), so while the ISO sweep held
 * it (it walks every org x connector against external APIs, which can take
 * minutes) every pod's Meet discovery found the lock taken and silently skipped
 * its tick, and the other way round: a Meet discovery in flight at the 6-hourly
 * ISO tick cost a whole sweep of compliance evidence. Neither side logged
 * anything, because "lock taken" is the normal "another pod has it" path.
 *
 * The fake pool below models Postgres session advisory locks across
 * connections (one session per connect(), reentrant within a session, held by
 * one session at a time), so the test exercises the real lock calls of both
 * modules against one shared lock table. Both take it through their
 * _setDepsForTests seam (the Meet tick lives in
 * core/automationRunner/scheduler/gmeetImportTick.js, which ticks.js mounts).
 *
 * Run: node --test jobs/isoEvidenceCollector.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── A shared advisory-lock table behind a fake pool ──────────────────────
//
// A numeric key and a hashtext(name) key live in one int8 keyspace in
// Postgres; here they are kept apart as `n:<int>` and `h:<name>`, which is
// what the named-lock helper relies on (a name never equals a numbered key in
// practice).
const held = new Map(); // key -> { session, count }
let nextSession = 1;

function lockKey(sql, params) {
    if (/hashtext\(\$1\)/.test(sql)) return `h:${params[0]}`;
    return `n:${params[0]}`;
}

const pool = {
    async connect() {
        const session = nextSession++;
        return {
            async query(sql, params = []) {
                if (/pg_try_advisory_lock/.test(sql)) {
                    const key = lockKey(sql, params);
                    const cur = held.get(key);
                    if (cur && cur.session !== session) return { rows: [{ locked: false }] };
                    held.set(key, { session, count: (cur ? cur.count : 0) + 1 });
                    return { rows: [{ locked: true }] };
                }
                if (/pg_advisory_unlock/.test(sql)) {
                    const key = lockKey(sql, params);
                    const cur = held.get(key);
                    if (!cur || cur.session !== session) return { rows: [{ pg_advisory_unlock: false }] };
                    if (cur.count > 1) cur.count -= 1; else held.delete(key);
                    return { rows: [{ pg_advisory_unlock: true }] };
                }
                throw new Error(`unexpected query in fake pool: ${sql}`);
            },
            release() {
                // Postgres drops a session's advisory locks when the session ends;
                // a pooled client keeps its session, so release() does not.
            },
        };
    },
};

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

// ── Fakes for the ISO collector ──────────────────────────────────────────
let isoGate = null; // when set, listEnabledConfigs waits on it (the sweep holds its lock meanwhile)
let isoListCalls = 0;
const isoCollector = require('./isoEvidenceCollector');
isoCollector._setDepsForTests({
    pool: () => pool,
    isoEvidenceStore: () => ({
        async listEnabledConfigs() {
            isoListCalls += 1;
            if (isoGate) await isoGate.promise;
            return [];
        },
        async markSweep() {},
        async saveSnapshot() { return { changed: false }; },
    }),
    connectors: () => ({ get: () => null }),
    recordJobRun: () => () => {},
});

// ── Fakes for the Meet auto-import tick ──────────────────────────────────
let gmeetGate = null; // when set, discover() waits on it (discovery holds its lock meanwhile)
const gmeet = { discover: 0, processDue: 0 };
const gmeetTick = require('../core/automationRunner/scheduler/gmeetImportTick');
gmeetTick._setDepsForTests({
    pool: () => pool,
    gmeetAutoImport: () => ({
        async discover() {
            gmeet.discover += 1;
            if (gmeetGate) await gmeetGate.promise;
        },
        async processDue() { gmeet.processDue += 1; },
    }),
});

test.after(() => {
    isoCollector._setDepsForTests();
    gmeetTick._setDepsForTests();
});

/** Spin the event loop until `cond()` holds; a bounded wait so a skipped pass fails instead of hanging. */
async function waitFor(cond, what) {
    for (let i = 0; i < 1000; i++) {
        if (cond()) return;
        await new Promise((r) => setImmediate(r));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** Let a pass left parked by a failed test finish, then start from a clean lock table. */
async function reset() {
    if (isoGate) isoGate.resolve();
    if (gmeetGate) gmeetGate.resolve();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    held.clear();
    isoGate = null;
    gmeetGate = null;
    isoListCalls = 0;
    gmeet.discover = 0;
    gmeet.processDue = 0;
}

test('Meet discovery still runs while the ISO sweep holds its lock', async () => {
    await reset();
    isoGate = deferred();
    const sweep = isoCollector.processSweep();
    // Let the sweep take its lock and park inside listEnabledConfigs.
    await waitFor(() => isoListCalls > 0, 'the ISO sweep to take its lock');

    await gmeetTick.processGmeetAutoImport();
    assert.strictEqual(gmeet.discover, 1,
        'Meet discovery was skipped while the ISO evidence sweep held its advisory lock: '
        + 'the two jobs share a lock key');
    assert.strictEqual(gmeet.processDue, 1, 'the ingest worker runs on every tick regardless of the lock');

    isoGate.resolve();
    await sweep;
    assert.strictEqual(held.size, 0, 'every advisory lock is released after both passes');
});

test('the ISO sweep still runs while a Meet discovery holds its lock', async () => {
    await reset();
    gmeetGate = deferred();
    const tick = gmeetTick.processGmeetAutoImport();
    await waitFor(() => gmeet.discover > 0, 'Meet discovery to take its lock');

    await isoCollector.processSweep();
    assert.strictEqual(isoListCalls, 1,
        'the ISO evidence sweep was skipped while a Meet discovery held its advisory lock');

    gmeetGate.resolve();
    await tick;
    assert.strictEqual(held.size, 0);
});

test('Meet discovery stays single-replica: a second pass while one is in flight skips discovery', async () => {
    await reset();
    gmeetGate = deferred();
    const first = gmeetTick.processGmeetAutoImport();
    await waitFor(() => gmeet.discover > 0, 'Meet discovery to take its lock');

    await gmeetTick.processGmeetAutoImport(); // another "pod" on its own session
    assert.strictEqual(gmeet.discover, 1, 'two replicas ran discovery at once');
    assert.strictEqual(gmeet.processDue, 1, 'the second pass still runs the ingest worker');

    gmeetGate.resolve();
    await first;
    assert.strictEqual(gmeet.processDue, 2);
    assert.strictEqual(held.size, 0);
});

test('the ISO sweep stays single-replica: a second sweep while one is in flight does nothing', async () => {
    await reset();
    isoGate = deferred();
    const first = isoCollector.processSweep();
    await waitFor(() => isoListCalls > 0, 'the ISO sweep to take its lock');
    // Same process: the inFlight guard answers before the lock is consulted.
    await isoCollector.processSweep();
    assert.strictEqual(isoListCalls, 1);
    isoGate.resolve();
    await first;
    assert.strictEqual(held.size, 0);
});
