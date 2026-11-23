// @typecheck
/**
 * How Cowork items start, on a real Postgres (PGlite): choosing a start takes the plan's approval away, and the items
 * that start after another one, on a table or on a token are found, each only for its own start, and the start of
 * the item's last run that ended well is read.
 *
 * Run: cd server && node --test stores/coworkStarts.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('./coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkStarts } = require('./coworkStarts.mts');

const starts = makeCoworkStarts({ ready: () => store.initDB() });
const DEF = { trigger: { id: 'trg', type: 'trigger', kind: 'schedule' }, steps: [{ id: 'a', type: 'set', values: {} }], edges: [{ from: 'trg', to: 'a' }] };

async function item(userId = 'u-starts', title = 'Item') {
    const s = await store.createSchedule({ userId, title, prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return /** @type {{ id: string }} */ (s).id;
}

test('a new start takes the approval away and is read back on the item', async () => {
    const id = await item();
    const plan = await store.approvePlan({ scheduleId: id, automationId: 'auto-1', definition: DEF, permissions: { v: 1, grants: [], sends: 'none', ai: false, outsideText: false }, fingerprint: 'f'.repeat(64), approvedBy: 'u-starts' });
    assert.strictEqual((await store.getSchedule(id))?.planId, plan.id);
    await starts.setStart(id, 'webhook', { tokenHash: 'h1' });
    const after = /** @type {any} */ (await store.getSchedule(id));
    assert.deepStrictEqual([after.triggerKind, after.trigger, after.planId], ['webhook', { tokenHash: 'h1' }, null]);
});

test('followers, table starters and the token are found for their own start only', async () => {
    const a = await item('u-chain', 'A');
    const b = await item('u-chain', 'B');
    const other = await item('u-other', 'C');
    await starts.setStart(b, 'after_cowork', { scheduleId: a });
    await starts.setStart(other, 'after_cowork', { scheduleId: a });
    assert.deepStrictEqual((await starts.listFollowers(a, 'u-chain')).map((i) => i.id), [b], 'only the owner\'s own items follow');
    const t = await item('u-chain', 'T');
    await starts.setStart(t, 'row', { datatableId: 'tbl-1' });
    assert.deepStrictEqual((await starts.listTableStarters('tbl-1')).map((i) => i.id), [t]);
    assert.deepStrictEqual(await starts.listTableStarters('tbl-2'), []);
    const h = await item('u-chain', 'H');
    await starts.setStart(h, 'webhook', { tokenHash: 'hash-h' });
    assert.strictEqual((await starts.findByHookHash('hash-h'))?.id, h);
    assert.strictEqual(await starts.findByHookHash('tbl-1'), null, 'a value of another start is no token');
});

test('where a run came from, and the latest run of an item', async () => {
    const id = await item('u-origin');
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Done.', { runId });
    assert.deepStrictEqual(await starts.runOrigin(runId), { id: runId, scheduleId: id, status: 'success', triggerKind: 'manual', triggerRef: null, result: 'Done.' });
    assert.strictEqual(await starts.latestRunId(id), runId);
    assert.strictEqual(await starts.runOrigin('no-run'), null);
});

test('the last good run: when the latest run that ended well started; a failure, a waiting or a running run move nothing', async () => {
    const id = await item('u-since');
    assert.strictEqual(await starts.lastGoodRunStart(id), null, 'a new item has no good run yet');
    /** @param {string} runId @param {string} status @param {string} startedAt */
    const runOf = (runId, status, startedAt) => pg.query(
        `INSERT INTO cowork_runs (id, schedule_id, user_id, status, started_at, finished_at) VALUES ($1, $2, 'u-since', $3, $4, $5)`,
        [runId, id, status, startedAt, status === 'running' || status === 'waiting' ? null : new Date(Date.parse(startedAt) + 600_000).toISOString()],
    );
    await runOf('since-1', 'success', '2026-11-20T06:30:00.000Z');
    assert.strictEqual(await starts.lastGoodRunStart(id), '2026-11-20T06:30:00.000Z', 'the START of the run, not its end');
    await runOf('since-2', 'error', '2026-11-21T06:30:00.000Z');
    await runOf('since-3', 'needs_reauth', '2026-11-21T07:30:00.000Z');
    assert.strictEqual(await starts.lastGoodRunStart(id), '2026-11-20T06:30:00.000Z', 'a failed run in between resets nothing');
    await runOf('since-4', 'needs_review', '2026-11-22T06:30:00.000Z');
    assert.strictEqual(await starts.lastGoodRunStart(id), '2026-11-22T06:30:00.000Z', 'a run that ended with a review ended well');
    await runOf('since-5', 'waiting', '2026-11-23T05:30:00.000Z');
    await runOf('since-6', 'running', '2026-11-23T06:30:00.000Z');
    assert.strictEqual(await starts.lastGoodRunStart(id), '2026-11-22T06:30:00.000Z', 'a run still waiting or running has not ended well yet');
    assert.strictEqual(await starts.lastGoodRunStart(await item('u-since-other')), null, 'per item');
});
