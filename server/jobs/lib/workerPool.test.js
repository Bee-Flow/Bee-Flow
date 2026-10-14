/**
 * jobs/lib/workerPool — the shared tick of the "scan what is due" jobs.
 * Pins what datatableNcSync and studioAppConnectorSync did inline before the
 * extraction: bounded parallelism, the numbered advisory lock taken and
 * released on the same client, a metric only for a pass this replica ran,
 * and no stacked ticks.
 *
 * Run: cd server && node --test jobs/lib/workerPool.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const runs = [];
const metricsPath = require.resolve('../../telemetry/metrics');
require.cache[metricsPath] = { id: metricsPath, filename: metricsPath, loaded: true, exports: { recordJobRun: (r) => runs.push(r) } };

const { runWorkerPool, createLockedTick } = require('./workerPool');

function fakePool({ locked = true } = {}) {
    const state = { sql: [], released: 0 };
    return {
        state,
        connect: async () => ({
            query: async (sql, params) => {
                state.sql.push([sql, params]);
                return /pg_try_advisory_lock/.test(sql) ? { rows: [{ locked }] } : { rows: [] };
            },
            release() { state.released++; },
        }),
    };
}

test.beforeEach(() => { runs.length = 0; });

test('runWorkerPool visits every item once with at most `concurrency` in flight', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    let active = 0; let peak = 0; const seen = [];
    await runWorkerPool(items, 3, async (n) => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, n % 3));
        seen.push(n);
        active--;
    });
    assert.deepStrictEqual(seen.sort(), items);
    assert.strictEqual(peak, 3);
});

test('runWorkerPool with no items starts no worker', async () => {
    let called = false;
    await runWorkerPool([], 3, async () => { called = true; });
    assert.strictEqual(called, false);
});

test('a locked tick takes the numbered lock, runs, unlocks on the same client and records ok', async () => {
    const pool = fakePool();
    let ran = 0;
    const tick = createLockedTick({ pool, lockKey: 42, job: 'j', label: 'J', run: async () => { ran++; return true; } });
    await tick();
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(pool.state.sql, [
        ['SELECT pg_try_advisory_lock($1) AS locked', [42]],
        ['SELECT pg_advisory_unlock($1)', [42]],
    ]);
    assert.strictEqual(pool.state.released, 1);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].job, 'j');
    assert.strictEqual(runs[0].status, 'ok');
});

test('a tick another replica owns runs nothing and records nothing', async () => {
    const pool = fakePool({ locked: false });
    let ran = 0;
    await createLockedTick({ pool, lockKey: 1, job: 'j', label: 'J', run: async () => { ran++; } })();
    assert.strictEqual(ran, 0);
    assert.strictEqual(pool.state.sql.length, 1, 'no unlock for a lock never held');
    assert.strictEqual(pool.state.released, 1);
    assert.strictEqual(runs.length, 0);
});

test('run returning false or throwing records an error and still unlocks', async () => {
    for (const run of [async () => false, async () => { throw new Error('boom'); }]) {
        runs.length = 0;
        const pool = fakePool();
        await createLockedTick({ pool, lockKey: 7, job: 'j', label: 'J', run })();
        assert.strictEqual(runs[0].status, 'error');
        assert.ok(pool.state.sql.some(([sql]) => /pg_advisory_unlock/.test(sql)));
        assert.strictEqual(pool.state.released, 1);
    }
});

test('a tick still in flight is not stacked', async () => {
    const pool = fakePool();
    let ran = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const tick = createLockedTick({ pool, lockKey: 9, job: 'j', label: 'J', run: async () => { ran++; await gate; } });
    const first = tick();
    await tick();
    release();
    await first;
    assert.strictEqual(ran, 1);
    await tick();
    assert.strictEqual(ran, 2, 'the guard is released after the pass');
});
