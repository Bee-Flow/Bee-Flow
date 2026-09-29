/**
 * Cowork store — the two things that are genuinely new here.
 *
 * 1. The runner surface. `aiTaskRunner.executeTask` drives cowork by being
 *    handed this store instead of aiTaskStore, so any method it calls that is
 *    missing or misnamed here is a runtime crash inside a background job —
 *    the worst place to find out. Checked structurally, no DB needed.
 *
 * 2. Run history. markRunning/markCompleted/markError are the only writers,
 *    and the history is a side effect of them, so the round-trip is what
 *    matters: an attempt opens exactly one row, and finishing closes that same
 *    row with the outcome. Needs Postgres; skips cleanly when it is absent so
 *    a machine without a local DB doesn't false-fail.
 *
 * Run: node --test stores/coworkStore.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const coworkStore = require('./coworkStore');
const aiTaskStore = require('./aiTaskStore');

// ── 1. Structural: the injected-store contract ──────────────────────────

// Every method executeTask/executeAgentRoutine calls on its `store`.
const RUNNER_SURFACE = ['markRunning', 'markCompleted', 'markError', 'advanceSchedule', 'updateTask'];

test('cowork store implements the whole runner surface', () => {
    const missing = RUNNER_SURFACE.filter(m => typeof coworkStore[m] !== 'function');
    assert.deepStrictEqual(missing, [], `coworkStore is missing: ${missing.join(', ')}`);
});

test('aiTaskStore exposes the same surface — the two are interchangeable', () => {
    const missing = RUNNER_SURFACE.filter(m => typeof aiTaskStore[m] !== 'function');
    assert.deepStrictEqual(missing, [], `aiTaskStore is missing: ${missing.join(', ')}`);
});

test('the runner only calls methods that exist on both stores', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'aiTaskRunner.js'), 'utf8');
    const called = new Set();
    const re = /\bstore\.([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) called.add(m[1]);

    assert.ok(called.size > 0, 'expected the runner to call the injected store');
    const bad = [...called].filter(
        name => typeof coworkStore[name] !== 'function' || typeof aiTaskStore[name] !== 'function',
    );
    assert.deepStrictEqual(bad, [], `runner calls store.${bad.join('/')} which is not on both stores`);
});

// ── 2. Integration: one attempt → one closed history row ────────────────

// CommonJS — no top-level await, so the probe is a memoised promise resolved
// inside each test. Returns a skip reason, or null when Postgres is there.
let _probe = null;
function pgUnavailable() {
    if (!_probe) {
        _probe = coworkStore
            .getScheduleCount(`probe_${crypto.randomBytes(3).toString('hex')}`)
            .then(() => null)
            .catch(err => `Postgres unavailable: ${err.message}`);
    }
    return _probe;
}

test('a successful attempt opens and closes exactly one run row', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);

    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'history round-trip',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    try {
        assert.strictEqual(await coworkStore.getRunCount(schedule.id), 0, 'starts with no history');

        await coworkStore.markRunning(schedule.id, { triggerKind: 'manual' });
        let runs = await coworkStore.listRuns(schedule.id);
        assert.strictEqual(runs.length, 1, 'markRunning opens one row');
        assert.strictEqual(runs[0].status, 'running');
        assert.strictEqual(runs[0].triggerKind, 'manual');
        assert.strictEqual(runs[0].finishedAt, null, 'an open run has no finish time');

        await coworkStore.markCompleted(schedule.id, 'the outcome');
        runs = await coworkStore.listRuns(schedule.id);
        assert.strictEqual(runs.length, 1, 'completing must not open a second row');
        assert.strictEqual(runs[0].status, 'success');
        assert.strictEqual(runs[0].result, 'the outcome');
        assert.ok(runs[0].finishedAt, 'a closed run has a finish time');
        assert.ok(runs[0].durationMs >= 0, 'duration is recorded');

        const after = await coworkStore.getSchedule(schedule.id);
        assert.strictEqual(after.lastStatus, 'success');
        assert.strictEqual(after.runCount, 1);
    } finally {
        await coworkStore.deleteSchedule(schedule.id);
    }
});

test('a failed attempt records the error, and history accumulates', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);
    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'failure history',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    try {
        await coworkStore.markRunning(schedule.id);
        await coworkStore.markCompleted(schedule.id, 'first run fine');
        await coworkStore.markRunning(schedule.id);
        await coworkStore.markError(schedule.id, new Error('provider exploded'));

        const runs = await coworkStore.listRuns(schedule.id);
        assert.strictEqual(runs.length, 2, 'the earlier run is kept, not overwritten');
        // Newest first.
        assert.strictEqual(runs[0].status, 'error');
        assert.strictEqual(runs[0].error, 'provider exploded');
        assert.strictEqual(runs[1].status, 'success', 'the successful run survives the failure');
        assert.strictEqual(runs[1].result, 'first run fine');

        assert.strictEqual(await coworkStore.getRunCount(schedule.id), 2);
    } finally {
        await coworkStore.deleteSchedule(schedule.id);
    }
});

test('an expired integration keeps its own status, as in aiTaskStore', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);
    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'reauth status',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    try {
        await coworkStore.markRunning(schedule.id);
        await coworkStore.markError(schedule.id, 'needs_reauth: token revoked');

        const [run] = await coworkStore.listRuns(schedule.id);
        assert.strictEqual(run.status, 'needs_reauth');
        const after = await coworkStore.getSchedule(schedule.id);
        assert.strictEqual(after.lastStatus, 'needs_reauth');
    } finally {
        await coworkStore.deleteSchedule(schedule.id);
    }
});

test('deleting a schedule takes its history with it', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);
    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'cascade',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    await coworkStore.markRunning(schedule.id);
    await coworkStore.markCompleted(schedule.id, 'done');
    assert.strictEqual(await coworkStore.getRunCount(schedule.id), 1);

    await coworkStore.deleteSchedule(schedule.id);
    assert.strictEqual(await coworkStore.getRunCount(schedule.id), 0, 'runs cascade with the schedule');
    assert.strictEqual(await coworkStore.getSchedule(schedule.id), null);
});

test('retention deletes only closed runs outside the window, and is idempotent', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);
    const { run } = require('../db');
    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'retention window',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    try {
        // Run 1: closed 100 days ago — outside every reasonable window.
        await coworkStore.markRunning(schedule.id);
        await coworkStore.markCompleted(schedule.id, 'ancient result');
        const [oldRun] = await coworkStore.listRuns(schedule.id);
        await run(
            `UPDATE cowork_runs
                SET started_at = NOW() - INTERVAL '100 days',
                    finished_at = NOW() - INTERVAL '100 days'
              WHERE id = $1`,
            [oldRun.id],
        );

        // Run 2: closed just now — inside the window.
        await coworkStore.markRunning(schedule.id);
        await coworkStore.markCompleted(schedule.id, 'fresh result');

        // Run 3: still open AND started long ago — the dangerous combination
        // (a wedged run is reapStaleRuns' problem, never retention's).
        await coworkStore.markRunning(schedule.id);
        const openRun = (await coworkStore.listRuns(schedule.id)).find(r => r.finishedAt === null);
        await run(
            `UPDATE cowork_runs SET started_at = NOW() - INTERVAL '100 days' WHERE id = $1`,
            [openRun.id],
        );

        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
        assert.strictEqual(await coworkStore.deleteRunsOlderThan(cutoff), 1,
            'exactly the old, closed row goes');

        const left = await coworkStore.listRuns(schedule.id);
        assert.strictEqual(left.length, 2);
        assert.ok(left.some(r => r.result === 'fresh result'), 'the recent closed row survives');
        assert.ok(left.some(r => r.finishedAt === null), 'an open row survives however old it is');
        assert.ok(!left.some(r => r.result === 'ancient result'), 'the old closed row is gone');

        assert.strictEqual(await coworkStore.deleteRunsOlderThan(cutoff), 0,
            'a second sweep deletes nothing new — idempotent');
    } finally {
        await coworkStore.deleteSchedule(schedule.id);
    }
});

test('closing with no open run is a no-op, not a crash', async (t) => {
    const skip = await pgUnavailable();
    if (skip) return t.skip(skip);
    // Happens after a restart mid-run, or when a manual run races the tick.
    const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const schedule = await coworkStore.createSchedule({
        userId,
        title: 'no open run',
        prompt: 'do the thing',
        nextRunAt: new Date().toISOString(),
    });
    try {
        await coworkStore.markCompleted(schedule.id, 'orphan result');
        assert.strictEqual(await coworkStore.getRunCount(schedule.id), 0, 'no history row is invented');
        const after = await coworkStore.getSchedule(schedule.id);
        assert.strictEqual(after.lastStatus, 'success', 'the schedule state is still updated');
    } finally {
        await coworkStore.deleteSchedule(schedule.id);
    }
});
