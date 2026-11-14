// @typecheck
/**
 * The cowork payload: the fields the Cowork screen reads, against a real
 * Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js) with the
 * store's own schema and NOW() pinned (testUtils/pgliteClock.js).
 *
 * Three properties, each with its own wound:
 *
 *   - CW-13 `produced_output`. A run that had nothing to report is SUCCESSFUL,
 *     and that judgement is made once (at closing) and stored, not guessed
 *     again each time from the result text. NULL is a third value: rows from
 *     before the column do not know, and reading them as "nothing produced"
 *     invents a statement about the past.
 *
 *   - CW-06 `currentRunStartedAt`. The source is the row that is open
 *     (`finished_at IS NULL`), not `last_status = 'running'`: those two drift
 *     apart as soon as reapStaleRuns cleans up a stuck attempt.
 *
 *   - CW-11 the aggregate. `failed` is "closed and not successful", so a
 *     status name added later does not fall through the gap, and a running
 *     run counts in neither outcome.
 *
 * Run: cd server && node --test stores/coworkStore.payload.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { pinPgliteNow } = require('../testUtils/pgliteClock');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const coworkStore = require('./coworkStore');
const { deriveProducedOutput } = coworkStore;

const NOW = new Date('2026-09-10T08:00:10.000Z');
const SEC = 1000;
const at = (ms) => new Date(NOW.getTime() + ms);

/** @type {{ set: (at: Date | string) => Promise<void> }} */
let clock;
before(async () => {
    await coworkStore.initDB();
    clock = await pinPgliteNow(pg, NOW);
});
after(close);
beforeEach(async () => {
    await pg.exec('TRUNCATE cowork_schedules CASCADE');
    await clock.set(NOW);
});

const schedule = (over = {}) => insertRow(pg, 'cowork_schedules', { id: 'cw-1', user_id: 'u1', title: 'Quotes', prompt: 'p', ...over });
const runRow = (over = {}) => insertRow(pg, 'cowork_runs', { id: `r-${Math.random().toString(36).slice(2)}`, schedule_id: 'cw-1', user_id: 'u1', ...over });
const storedRun = async (id) => (await pg.query('SELECT * FROM cowork_runs WHERE id = $1', [id])).rows[0];
const storedSchedule = async (id = 'cw-1') => (await pg.query('SELECT * FROM cowork_schedules WHERE id = $1', [id])).rows[0];

/** A schedule with one open run that started four seconds before NOW. */
async function withOpenRun() {
    await schedule({ last_status: 'running' });
    return runRow({ id: 'run-open', status: 'running', started_at: at(-4 * SEC) });
}

// ── CW-13: "was there anything to report" ─────────────────────────────

test('empty and the "no text result" marker count as nothing produced', () => {
    assert.strictEqual(deriveProducedOutput(null), false);
    assert.strictEqual(deriveProducedOutput(undefined), false);
    assert.strictEqual(deriveProducedOutput(''), false);
    assert.strictEqual(deriveProducedOutput('   \n  '), false);
    // The literal shape aiTaskRunner writes when the model wrote nothing.
    assert.strictEqual(
        deriveProducedOutput('_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_'),
        false);
    // The same shape in other words: the inference hangs on the SHAPE, not on
    // the sentence, or it breaks as soon as the text is translated.
    assert.strictEqual(deriveProducedOutput('_(Nothing to report.)_'), false);
});

test('a real result counts, even when it starts in italics', () => {
    assert.strictEqual(deriveProducedOutput('3 offertes klaargezet'), true);
    assert.strictEqual(deriveProducedOutput('_(let op)_ en dan 3 offertes'), true, 'a marker with text around it is an answer');
    assert.strictEqual(deriveProducedOutput('0'), true, 'the digit zero is an outcome, not emptiness');
});

test('markCompleted stores the judgement with the closing of the run, and its duration', async () => {
    await withOpenRun();
    await coworkStore.markCompleted('cw-1', '3 offertes klaargezet');
    const r = await storedRun('run-open');
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.result, '3 offertes klaargezet');
    assert.strictEqual(r.produced_output, true);
    assert.strictEqual(r.finished_at.toISOString(), NOW.toISOString());
    assert.strictEqual(r.duration_ms, 4000);
    const s = await storedSchedule();
    assert.strictEqual(s.last_status, 'success');
    assert.strictEqual(s.run_count, 1);
});

test('"nothing to report" is a SUCCESSFUL run with produced_output false', async () => {
    await withOpenRun();
    await coworkStore.markCompleted('cw-1', '_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_');
    const r = await storedRun('run-open');
    assert.strictEqual(r.status, 'success', 'the status stays successful — that is the whole finding');
    assert.strictEqual(r.produced_output, false);
});

test('a caller that knows for certain overrides the inference', async () => {
    await withOpenRun();
    // The runner knows whether there was tool output; that must not be lost to a text inference.
    await coworkStore.markCompleted('cw-1', 'looks empty', { producedOutput: false });
    assert.strictEqual((await storedRun('run-open')).produced_output, false);

    await runRow({ id: 'run-2', status: 'running', started_at: at(-SEC) });
    await coworkStore.markCompleted('cw-1', '', { producedOutput: true });
    assert.strictEqual((await storedRun('run-2')).produced_output, true);
});

// markError passes no `result`, so deriveProducedOutput(undefined) is already
// false: this pins the stored value on a failed row, not that markError says so itself.
test('a failed run by definition produced nothing', async () => {
    await withOpenRun();
    await coworkStore.markError('cw-1', new Error('provider exploded'));
    const r = await storedRun('run-open');
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.produced_output, false);
    assert.strictEqual((await storedSchedule()).last_status, 'error');
});

test('only the open run is closed; nothing open means nothing written', async () => {
    await schedule();
    const done = await runRow({ id: 'run-done', status: 'success', started_at: at(-60 * SEC), finished_at: at(-50 * SEC), result: 'old' });
    await coworkStore.markCompleted('cw-1', 'new');
    assert.deepStrictEqual(await storedRun('run-done'), done);
});

test('a reaped stuck run is closed as an error with produced_output false, and its schedule released', async () => {
    await schedule({ last_status: 'running' });
    await schedule({ id: 'cw-moved', last_status: 'success' });
    await runRow({ id: 'stuck', status: 'running', started_at: at(-31 * 60 * SEC) });
    await runRow({ id: 'stuck-2', schedule_id: 'cw-moved', status: 'running', started_at: at(-40 * 60 * SEC) });
    await runRow({ id: 'young', status: 'running', started_at: at(-29 * 60 * SEC) });

    assert.strictEqual(await coworkStore.reapStaleRuns(), 2);
    const r = await storedRun('stuck');
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.produced_output, false);
    assert.strictEqual(r.finished_at.toISOString(), NOW.toISOString());
    assert.strictEqual(r.duration_ms, 31 * 60 * 1000);
    assert.strictEqual((await storedRun('young')).finished_at, null, 'a run inside the window is left alone');
    assert.strictEqual((await storedSchedule()).last_status, 'error');
    assert.strictEqual((await storedSchedule('cw-moved')).last_status, 'success', 'a schedule that moved on is not overwritten');
});

test('the column comes from this store\'s boot DDL, nullable', async () => {
    const { rows } = await pg.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'cowork_runs' AND column_name = 'produced_output'`);
    assert.deepStrictEqual(rows, [{ data_type: 'boolean', is_nullable: 'YES', column_default: null }]);
});

test('listRuns passes true, false and null through — null stays null', async () => {
    await schedule();
    await runRow({ id: 'r1', status: 'success', produced_output: true, started_at: at(-3 * SEC) });
    await runRow({ id: 'r2', status: 'success', produced_output: false, started_at: at(-2 * SEC) });
    await runRow({ id: 'r3', status: 'success', produced_output: null, started_at: at(-1 * SEC) });
    const runs = await coworkStore.listRuns('cw-1');
    assert.deepStrictEqual(runs.map((r) => [r.id, r.producedOutput]), [['r3', null], ['r2', false], ['r1', true]],
        'a row from before the column does not know, and that is not a "no"');
});

// ── CW-06: the start time of the running run ──────────────────────────

test('the open run is found by finished_at IS NULL, not by a status', async () => {
    await schedule({ last_status: 'error' });
    // After a reap of an older attempt a new one opened: the row is open, its
    // status is no longer 'running'.
    await runRow({ id: 'open', status: 'queued', started_at: at(-4 * SEC) });
    await runRow({ id: 'closed', status: 'running', started_at: at(-2 * SEC), finished_at: at(-SEC) });
    assert.strictEqual(await coworkStore.getOpenRunStart('cw-1'), at(-4 * SEC).toISOString());
});

test('nothing open → null, no invented time', async () => {
    await schedule();
    await runRow({ status: 'success', finished_at: NOW });
    assert.strictEqual(await coworkStore.getOpenRunStart('cw-1'), null);
});

test('the list variant answers for the whole user in one go: the newest open run per schedule', async () => {
    await schedule({ id: 'cw-a' });
    await schedule({ id: 'cw-b' });
    await schedule({ id: 'cw-c', user_id: 'u2' });
    await runRow({ schedule_id: 'cw-a', status: 'running', started_at: at(-9 * SEC) });
    await runRow({ schedule_id: 'cw-a', status: 'queued', started_at: at(-4 * SEC) });
    await runRow({ schedule_id: 'cw-b', status: 'running', started_at: at(-2 * SEC), finished_at: at(-SEC) });
    await runRow({ schedule_id: 'cw-c', user_id: 'u2', status: 'running', started_at: at(-SEC) });
    assert.deepStrictEqual(await coworkStore.getOpenRunStarts('u1'), { 'cw-a': at(-4 * SEC).toISOString() });
});

// ── CW-11: the aggregate ──────────────────────────────────────────────

test('the aggregate counts success apart and "failed" as closed-and-not-successful', async () => {
    await schedule();
    for (let i = 0; i < 3; i++) await runRow({ status: 'success', finished_at: NOW, duration_ms: 1000 * (i + 1) });
    await runRow({ status: 'error', finished_at: NOW, duration_ms: 6000 });
    // A status added later still counts as failed: no list of error statuses.
    await runRow({ status: 'needs_reauth', finished_at: NOW, duration_ms: 8000 });
    await runRow({ status: 'some_future_status', finished_at: NOW, duration_ms: 4000 });
    // A running run has no duration yet: in the total, in neither outcome, not in the average.
    await runRow({ status: 'running', duration_ms: 999999 });
    await schedule({ id: 'cw-other' });
    await runRow({ schedule_id: 'cw-other', status: 'error', finished_at: NOW, duration_ms: 1 });
    assert.deepStrictEqual(await coworkStore.getRunStats('cw-1'), { total: 7, success: 3, failed: 3, avgDurationMs: 4000 });
});

test('never a finished attempt gives null, not 0 ms', async () => {
    await schedule();
    await runRow({ status: 'running' });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, null, '"nothing measured yet" is not "0 ms on average"');
    assert.strictEqual(stats.total, 1);
});

test('a MEASURED 0 stays 0 — the other half of the same rule', async () => {
    await schedule();
    for (let i = 0; i < 3; i++) await runRow({ status: 'success', finished_at: NOW, duration_ms: 0 });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, 0);
});

test('a schedule without history gives zeros instead of failing', async () => {
    assert.deepStrictEqual(await coworkStore.getRunStats('cw-1'), { total: 0, success: 0, failed: 0, avgDurationMs: null });
});
