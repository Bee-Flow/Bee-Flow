/**
 * The run ledger of event-triggered agents, on real SQL (PGlite): one run per (schedule, message), the schedule
 * flips to running only for the run that won the claim, and the hourly count.
 *
 * Run: node --test stores/coworkTriggerStore.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeCoworkTriggerStore } = require('./coworkTriggerStore');

const { pg, db } = pgliteDb();
const store = makeCoworkTriggerStore(db);

before(async () => {
    await pg.exec(`
        CREATE TABLE cowork_schedules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, last_status TEXT DEFAULT 'pending');
        CREATE TABLE cowork_runs (
            id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL, status TEXT NOT NULL, trigger_kind TEXT NOT NULL DEFAULT 'schedule',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), trigger_ref TEXT
        );
        CREATE UNIQUE INDEX idx_cowork_runs_trigger_ref ON cowork_runs(schedule_id, trigger_ref) WHERE trigger_ref IS NOT NULL;
        INSERT INTO cowork_schedules (id, user_id) VALUES ('s1', 'u1'), ('s2', 'u1');
    `);
});
after(async () => { await pg.close(); });

test('the first claim of a message opens a running run; a second claim of the same message is null', async () => {
    const first = await store.claimEventRun({ scheduleId: 's1', userId: 'u1', triggerRef: 'msg-1' });
    assert.ok(first);
    assert.strictEqual((await store.claimEventRun({ scheduleId: 's1', userId: 'u1', triggerRef: 'msg-1' })), null);
    const row = (await pg.query(`SELECT status, trigger_kind, trigger_ref FROM cowork_runs WHERE id = $1`, [first])).rows[0];
    assert.deepStrictEqual(row, { status: 'running', trigger_kind: 'mail', trigger_ref: 'msg-1' });
    assert.strictEqual((await pg.query(`SELECT last_status FROM cowork_schedules WHERE id = 's1'`)).rows[0].last_status, 'running');
});

test('the same message id on another schedule is its own event', async () => {
    assert.ok(await store.claimEventRun({ scheduleId: 's2', userId: 'u1', triggerRef: 'msg-1' }));
});

test('a schedule of another user cannot be claimed', async () => {
    assert.strictEqual(await store.claimEventRun({ scheduleId: 's1', userId: 'someone-else', triggerRef: 'msg-x' }), null);
});

test('a lost claim leaves the schedule status alone', async () => {
    await pg.query(`UPDATE cowork_schedules SET last_status = 'success' WHERE id = 's1'`);
    assert.strictEqual(await store.claimEventRun({ scheduleId: 's1', userId: 'u1', triggerRef: 'msg-1' }), null);
    assert.strictEqual((await pg.query(`SELECT last_status FROM cowork_schedules WHERE id = 's1'`)).rows[0].last_status, 'success');
});

test('countRecentEventRuns counts only runs of that kind inside the window', async () => {
    await pg.query(`INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind, started_at, trigger_ref)
                    VALUES ('old', 's1', 'u1', 'success', 'mail', NOW() - INTERVAL '3 hours', 'msg-old')`);
    await pg.query(`INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind) VALUES ('sched', 's1', 'u1', 'success', 'schedule')`);
    assert.strictEqual(await store.countRecentEventRuns({ scheduleId: 's1', sinceMs: 60 * 60 * 1000 }), 1);
    assert.strictEqual(await store.countRecentEventRuns({ scheduleId: 's1', sinceMs: 5 * 60 * 60 * 1000 }), 2);
});
