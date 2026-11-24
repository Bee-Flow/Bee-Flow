// @typecheck
/**
 * The goals of Cowork items on a real Postgres (PGlite): one goal per item, a new sentence takes the check's approval
 * off, a measurement is claimed once per window and only for an approved check, a run is measured once, and taking
 * the goal off takes its measurements with it.
 *
 * Run: cd server && node --test stores/coworkGoals.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeCoworkGoals, COWORK_GOALS_DDL, ERROR_MAX } = require('./coworkGoals.mts');

const { pg, db } = pgliteDb();
const store = makeCoworkGoals(db);

before(async () => {
    await pg.exec("CREATE TABLE cowork_schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Supplier radar')");
    for (const id of ['w1', 'w2', 'w3', 'w4']) await pg.query('INSERT INTO cowork_schedules (id) VALUES ($1)', [id]);
    for (const sql of COWORK_GOALS_DDL) await pg.exec(sql);
});
after(async () => { await pg.close(); });

const SENTENCE = 'Every supplier mail gets an answer within two working days';
const at = (/** @type {string} */ t) => new Date(`2026-11-23T${t}:00Z`);

test('a goal is written once per item; the same sentence keeps the check, a new one takes it off', async () => {
    assert.strictEqual(await store.getGoal('w1'), null);
    const made = await store.saveGoal({ scheduleId: 'w1', userId: 'ann', sentence: SENTENCE, targetPercent: 95 });
    assert.deepStrictEqual([made.sentence, made.targetPercent, made.checkAutomationId, made.approvedDefinition], [SENTENCE, 95, null, null]);
    assert.strictEqual(await store.setCheck('w1', 'auto-check'), true);
    assert.strictEqual(await store.approveCheck('w1', { definition: { steps: [{ id: 'n', type: 'set' }] }, fingerprint: 'f'.repeat(64) }), true);

    const sameSentence = await store.saveGoal({ scheduleId: 'w1', userId: 'ann', sentence: SENTENCE, targetPercent: 90 });
    assert.deepStrictEqual([sameSentence.targetPercent, sameSentence.checkAutomationId, sameSentence.fingerprint], [90, 'auto-check', 'f'.repeat(64)]);
    assert.deepStrictEqual(sameSentence.approvedDefinition, { steps: [{ id: 'n', type: 'set' }] });
    assert.ok(sameSentence.approvedAt);

    const reworded = await store.saveGoal({ scheduleId: 'w1', userId: 'ann', sentence: 'Every mail gets an answer the same day', targetPercent: 90 });
    assert.deepStrictEqual([reworded.checkAutomationId, reworded.approvedDefinition, reworded.fingerprint, reworded.approvedAt], [null, null, null, null]);
});

test('a new check is not approved until its owner approves it', async () => {
    await store.saveGoal({ scheduleId: 'w2', userId: 'ann', sentence: SENTENCE, targetPercent: 100 });
    await store.setCheck('w2', 'auto-1');
    await store.approveCheck('w2', { definition: { v: 1 }, fingerprint: 'a'.repeat(64) });
    await store.setCheck('w2', 'auto-2');
    const goal = await store.getGoal('w2');
    assert.deepStrictEqual([goal?.checkAutomationId, goal?.approvedDefinition, goal?.fingerprint], ['auto-2', null, null]);
    assert.strictEqual(await store.setCheck('nothing-here', 'auto-3'), false);
});

test('a measurement is claimed once per window, and only for an approved check', async () => {
    await store.saveGoal({ scheduleId: 'w3', userId: 'bob', sentence: SENTENCE, targetPercent: 100 });
    const window = 15 * 60_000;
    assert.strictEqual(await store.claimMeasurement('w3', at('09:00'), window), false, 'no approved check: nothing to measure');
    await store.setCheck('w3', 'auto-check');
    await store.approveCheck('w3', { definition: { v: 1 }, fingerprint: 'b'.repeat(64) });
    assert.strictEqual(await store.claimMeasurement('w3', at('09:00'), window), true);
    assert.strictEqual(await store.claimMeasurement('w3', at('09:10'), window), false, 'ten minutes later: the same window');
    assert.strictEqual(await store.claimMeasurement('w3', at('09:15'), window), true, 'fifteen minutes later: a new one');
});

test('a run is measured once; the results come newest first; the owner\'s counts take the latest good one', async () => {
    await store.recordResult('w3', { runId: 'r1', met: 40, total: 49, period: 'this week', ok: true, error: null, measuredAt: at('09:00') });
    await store.recordResult('w3', { runId: 'r1', met: 1, total: 1, period: null, ok: true, error: null, measuredAt: at('09:01') });
    await store.recordResult('w3', { runId: 'r2', met: 46, total: 49, period: 'this week', ok: true, error: null, measuredAt: at('10:00') });
    await store.recordResult('w3', { runId: 'r3', met: null, total: null, period: null, ok: false, error: 'x'.repeat(ERROR_MAX + 50), measuredAt: at('11:00') });
    const results = await store.listResults('w3');
    assert.deepStrictEqual(results.map((r) => [r.runId, r.met, r.total, r.ok]), [['r3', null, null, false], ['r2', 46, 49, true], ['r1', 40, 49, true]]);
    assert.strictEqual(results[0].error?.length, ERROR_MAX, 'a reason is kept short');
    const counts = await store.countsOfOwner('bob');
    assert.deepStrictEqual(counts.map((c) => [c.scheduleId, c.title, c.met, c.total, c.period]), [['w3', 'Supplier radar', 46, 49, 'this week']], 'the failed measurement does not hide the last good count');
    assert.deepStrictEqual(await store.countsOfOwner('nobody'), []);
});

test('taking the goal off takes its measurements; deleting the item takes both', async () => {
    await store.removeGoal('w3');
    assert.strictEqual(await store.getGoal('w3'), null);
    assert.deepStrictEqual(await store.listResults('w3'), []);
    await store.saveGoal({ scheduleId: 'w4', userId: 'cy', sentence: SENTENCE, targetPercent: 100 });
    await store.recordResult('w4', { runId: 'r9', met: 1, total: 2, period: null, ok: true, error: null, measuredAt: at('12:00') });
    await pg.query('DELETE FROM cowork_schedules WHERE id = $1', ['w4']);
    assert.strictEqual(await store.getGoal('w4'), null);
    assert.deepStrictEqual(await store.listResults('w4'), []);
});
