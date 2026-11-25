/**
 * The replay store (./coworkReplays.mts) on a real Postgres in-process (PGlite behind db.js): one running replay per
 * item, a replay left running by a stopped server closed as failed, each past run counted once, an item's last few
 * replays kept, a replay read only through its own item, and the past runs with the plan each followed then.
 *
 * Run: cd server && node --test stores/coworkReplays.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('./coworkStore.testkit').coworkStoreOnPglite();
const { coworkReplays, initDB, KEEP } = require('./coworkReplays.mts');

const replays = coworkReplays();
before(async () => { await initDB(); });

async function item(userId = 'u-replays') {
    const s = await store.createSchedule({ userId, title: 'Digest', prompt: 'Sum up.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return /** @type {{ id: string }} */ (s).id;
}
const begin = (scheduleId, id) => replays.beginReplay({ id, scheduleId, userId: 'u-replays', fingerprint: 'f'.repeat(64), total: 2 });

test('one running replay per item; another item is not held up', async () => {
    const [a, b] = [await item(), await item()];
    assert.strictEqual(await begin(a, 'rp-a1'), true);
    assert.strictEqual(await begin(a, 'rp-a2'), false, 'the second press gets no replay');
    assert.strictEqual(await begin(b, 'rp-b1'), true);
    await replays.finishReplay('rp-a1', 'done');
    assert.strictEqual(await begin(a, 'rp-a3'), true, 'once it is done, a new one may start');
});

test('a replay left running by a stopped server is closed as failed', async () => {
    const a = await item();
    await begin(a, 'rp-stale');
    await pg.query(`UPDATE cowork_replays SET started_at = NOW() - INTERVAL '3 hours' WHERE id = 'rp-stale'`);
    assert.strictEqual(await begin(a, 'rp-fresh'), true);
    assert.strictEqual((await replays.getReplay(a, 'rp-stale'))?.replay.status, 'failed');
});

test('each past run is counted once, and the verdicts hold step ids and counts only', async () => {
    const a = await item();
    await begin(a, 'rp-count');
    const event = { pastRunId: 'run-1', pastStartedAt: '2026-11-01T08:00:00.000Z', verdict: 'differs', reason: null, missingSteps: 0, differingSteps: ['send'] };
    await replays.addEvent('rp-count', event);
    await replays.addEvent('rp-count', event);
    await replays.addEvent('rp-count', { ...event, pastRunId: 'run-2', pastStartedAt: '2026-11-02T08:00:00.000Z', verdict: 'partial', missingSteps: 2, differingSteps: [] });
    await replays.finishReplay('rp-count', 'done');
    const found = await replays.getReplay(a, 'rp-count');
    assert.deepStrictEqual([found?.replay.status, found?.replay.differs, found?.replay.partial, found?.replay.same], ['done', 1, 1, 0]);
    assert.deepStrictEqual(found?.events.map((e) => [e.pastRunId, e.verdict, e.missingSteps, e.differingSteps]), [['run-2', 'partial', 2, []], ['run-1', 'differs', 0, ['send']]], 'newest past run first');
    assert.strictEqual(await replays.getReplay(await item(), 'rp-count'), null, 'another item does not see it');
});

test('an item keeps its last replays', async () => {
    const a = await item();
    for (let i = 0; i < KEEP + 2; i++) {
        await begin(a, `rp-keep-${i}`);
        await pg.query(`UPDATE cowork_replays SET started_at = NOW() - ($2::int * INTERVAL '1 minute') WHERE id = $1`, [`rp-keep-${i}`, KEEP + 2 - i]);
        await replays.finishReplay(`rp-keep-${i}`, 'done');
    }
    const { rows } = await pg.query('SELECT id FROM cowork_replays WHERE schedule_id = $1 ORDER BY started_at', [a]);
    assert.strictEqual(rows.length, KEEP);
    assert.strictEqual(await replays.getReplay(a, 'rp-keep-0'), null, 'the oldest went');
});

test('the past runs are the finished ones, newest first, with the plan each followed then', async () => {
    const a = await item();
    const prompt = await store.markRunning(a, { triggerKind: 'manual' });
    await store.markCompleted(a, 'Asked the AI.', { runId: prompt });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const planned = await store.markRunning(a, { triggerKind: 'manual' });
    await store.markCompleted(a, 'Followed the plan.', { runId: planned });
    const definition = { steps: [{ id: 'facts', type: 'set' }] };
    await pg.query(`INSERT INTO cowork_plans (id, schedule_id, automation_id, version, definition_json, permissions_json, fingerprint, approved_by)
                    VALUES ('plan-1', $1, 'auto-1', 1, $2, '{}', $3, 'u-replays')`, [a, JSON.stringify(definition), 'f'.repeat(64)]);
    await pg.query(`UPDATE cowork_runs SET plan_id = 'plan-1', automation_run_id = 'ar-1', trusted_steps = '["send"]' WHERE id = $1`, [planned]);
    const running = await store.markRunning(a, { triggerKind: 'manual' });
    const past = await replays.pastRunsOf(a, 10);
    assert.deepStrictEqual(past.map((p) => [p.id, p.automationRunId, p.planDefinition, p.trustedSteps]), [[planned, 'ar-1', definition, ['send']], [prompt, null, null, []]]);
    assert.ok(!past.some((p) => p.id === running), 'a run still going is not a past run');
    assert.strictEqual((await replays.pastRunsOf(a, 1)).length, 1);
});

test('the replays go with their item', async () => {
    const a = await item();
    await begin(a, 'rp-gone');
    await replays.addEvent('rp-gone', { pastRunId: 'run-1', pastStartedAt: null, verdict: 'same', reason: null, missingSteps: 0, differingSteps: [] });
    await pg.query('DELETE FROM cowork_schedules WHERE id = $1', [a]);
    const left = await pg.query(`SELECT (SELECT COUNT(*)::int FROM cowork_replays WHERE id = 'rp-gone') AS r, (SELECT COUNT(*)::int FROM cowork_replay_events WHERE replay_id = 'rp-gone') AS e`);
    assert.deepStrictEqual(left.rows[0], { r: 0, e: 0 });
});
