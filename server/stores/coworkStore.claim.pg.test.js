// @typecheck
/**
 * One claim per run, on the store's own schema and SQL (PGlite behind db.js):
 *
 *   - of two attempts on one schedule, one gets the run and the other gets null: two replicas that read the same due
 *     row, or a run-now pressed while a scheduled run is busy;
 *   - a claim made for a due moment (`due`, the scheduler tick) is refused once that moment was run and moved on, or
 *     the item was paused: the stale read of a slow replica starts nothing;
 *   - a claim that could not start is given back, and the schedule is due again;
 *   - after downtime the schedule moves to its first moment ahead, not one step on.
 *
 * Run: cd server && node --test stores/coworkStore.claim.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { coworkStoreOnPglite } = require('./coworkStore.testkit');

const { pg, store } = coworkStoreOnPglite();

const USER = 'u-claim';
const HOUR = 3_600_000;

/** A schedule that is due now (its moment lies `agoMs` in the past). */
async function dueSchedule(over = {}, agoMs = 60_000) {
    const s = await store.createSchedule({
        userId: USER, title: 'Supplier radar', prompt: 'Summarise the new supplier mail.', repeatInterval: 'hourly',
        nextRunAt: new Date(Date.now() - agoMs).toISOString(), ...over,
    });
    return /** @type {{ id: string, nextRunAt: string }} */ (s);
}

const openRuns = async (id) => (await pg.query('SELECT id FROM cowork_runs WHERE schedule_id = $1 AND finished_at IS NULL', [id])).rows.length;
const statusOf = async (id) => /** @type {{ last_status: string }} */ ((await pg.query('SELECT last_status FROM cowork_schedules WHERE id = $1', [id])).rows[0]).last_status;

test('of two claims on one schedule, the second gets null and opens no second row', async () => {
    const s = await dueSchedule();
    const first = await store.markRunning(s.id, { due: true });
    const second = await store.markRunning(s.id, { due: true });
    assert.strictEqual(typeof first, 'string');
    assert.strictEqual(second, null, 'another replica that read the same due row starts nothing');
    assert.strictEqual(await openRuns(s.id), 1);
    assert.strictEqual(await statusOf(s.id), 'running');
});

test('a run-now while a run is busy is refused as well', async () => {
    const s = await dueSchedule();
    assert.ok(await store.markRunning(s.id, { due: true }));
    assert.strictEqual(await store.markRunning(s.id, { triggerKind: 'manual' }), null);
    assert.strictEqual(await openRuns(s.id), 1);
});

test('once a run closed, the schedule can be claimed again', async () => {
    const s = await dueSchedule();
    assert.ok(await store.markRunning(s.id, { triggerKind: 'manual' }));
    await store.markCompleted(s.id, 'Done.');
    assert.ok(await store.markRunning(s.id, { triggerKind: 'manual' }), 'a later run-now starts');
    await store.markError(s.id, new Error('provider said no'));
    assert.ok(await store.markRunning(s.id, { triggerKind: 'manual' }), 'and one after a failure too');
});

test('a claim for a due moment is refused once that moment was run and moved on', async () => {
    const s = await dueSchedule();
    // Replica A: claims, runs, closes, moves the schedule on.
    assert.ok(await store.markRunning(s.id, { due: true }));
    await store.markCompleted(s.id, 'Done.');
    await store.advanceSchedule(s.id, s.nextRunAt, 'hourly');
    // Replica B still holds the due row it read before A finished.
    assert.strictEqual(await store.markRunning(s.id, { due: true }), null, 'the stale read starts no second run');
    assert.strictEqual(await openRuns(s.id), 0);
    assert.strictEqual(await statusOf(s.id), 'success', 'and does not touch the status');
});

test('a claim for a due moment is refused on a paused item and on a one-off that already ran', async () => {
    const paused = await dueSchedule();
    await store.updateSchedule(paused.id, { isActive: false });
    assert.strictEqual(await store.markRunning(paused.id, { due: true }), null);

    const oneOff = await dueSchedule({ repeatInterval: null });
    assert.ok(await store.markRunning(oneOff.id, { due: true }));
    await store.markCompleted(oneOff.id, 'Done.');
    await store.advanceSchedule(oneOff.id, oneOff.nextRunAt, null); // a one-off switches itself off
    assert.strictEqual(await store.markRunning(oneOff.id, { due: true }), null);
});

test('a run-now does not need the item to be due: it runs a paused item and one planned for next week', async () => {
    const future = await dueSchedule({}, -7 * 24 * HOUR);
    assert.strictEqual(await store.markRunning(future.id, { due: true }), null, 'the tick would not run it yet');
    assert.ok(await store.markRunning(future.id, { triggerKind: 'manual' }), 'a person can');
});

test('an unknown schedule is not claimed', async () => {
    assert.strictEqual(await store.markRunning('no-such-schedule'), null);
});

test('a claim that could not start is given back: no row stays open and the item is due again', async () => {
    const s = await dueSchedule();
    const runId = await store.markRunning(s.id, { due: true });
    await store.releaseRun(s.id, runId);
    assert.strictEqual(await openRuns(s.id), 0);
    assert.strictEqual(await statusOf(s.id), 'pending');
    assert.strictEqual((await store.getDueSchedules()).some((d) => d.id === s.id), true, 'the next tick picks it up');
    assert.ok(await store.markRunning(s.id, { due: true }), 'and can claim it');
});

test('giving back is exact: a run that already closed stays in the history, and a missing run id does nothing', async () => {
    const s = await dueSchedule();
    const runId = await store.markRunning(s.id, { triggerKind: 'manual' });
    await store.markCompleted(s.id, 'Done.');
    await store.releaseRun(s.id, runId);
    await store.releaseRun(s.id, null);
    assert.strictEqual(await store.getRunCount(s.id), 1);
    assert.strictEqual(await statusOf(s.id), 'success');
});

test('after downtime the schedule moves to its first moment ahead, in one step', async () => {
    const threeDaysAgo = new Date(Date.now() - 72 * HOUR);
    const s = await dueSchedule({ nextRunAt: threeDaysAgo.toISOString() });
    const next = /** @type {string} */ (await store.advanceSchedule(s.id, s.nextRunAt, 'hourly'));
    const ahead = new Date(next).getTime() - Date.now();
    assert.ok(ahead > 0 && ahead <= HOUR, `the next run is within the hour ahead, got ${Math.round(ahead / 60_000)} min`);
    assert.strictEqual((await store.getDueSchedules()).some((d) => d.id === s.id), false, 'it is not due again on the next tick');
});
