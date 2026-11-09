// @typecheck
/**
 * agent-mail-trigger-2026-11 against a real Postgres (pglite behind the real db.js).
 *
 * Proven: an existing automation row keeps working; a subscription may belong to
 * a Cowork item instead; exactly one owner is allowed; the cowork side (nullable
 * next_run_at, trigger_kind default, one run per (schedule, trigger_ref)) is
 * there; deleting the schedule takes its subscriptions along; a second run is a
 * no-op; the migration is registered in the automationStore ladder.
 *
 * Run: cd server && node --test migrations/agent-mail-trigger-2026-11.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { up } = require('./agent-mail-trigger-2026-11');

const sub = (id, automationId, scheduleId) => pg.query(
    `INSERT INTO automation_event_subscriptions (id, automation_id, cowork_schedule_id, user_id, provider, event_type)
     VALUES ($1, $2, $3, 'u1', 'gmail', 'mail.new')`,
    [id, automationId, scheduleId],
);

before(async () => {
    await require('./automation-builder-2026-05-init').up();
    await pg.query(
        `INSERT INTO automations (id, user_id, title, definition_json) VALUES ('a1', 'u1', 't', '{}')`,
    );
    // A row from before the migration: owned by an automation, no cowork column yet.
    await pg.query(
        `INSERT INTO automation_event_subscriptions (id, automation_id, user_id, provider, event_type)
         VALUES ('old', 'a1', 'u1', 'gmail', 'mail.new')`,
    );
    await up();
});
after(close);

test('an existing automation subscription survives the migration', async () => {
    const { rows } = await pg.query(`SELECT automation_id, cowork_schedule_id FROM automation_event_subscriptions WHERE id = 'old'`);
    assert.deepStrictEqual(rows[0], { automation_id: 'a1', cowork_schedule_id: null });
});

test('a subscription can belong to a cowork schedule that has no clock', async () => {
    await pg.query(
        `INSERT INTO cowork_schedules (id, user_id, title, prompt, trigger_kind, trigger_json)
         VALUES ('s1', 'u1', 't', 'p', 'app_event', '{"provider":"gmail","event":"mail.new"}')`,
    );
    await sub('cw', null, 's1');
    const { rows } = await pg.query(`SELECT next_run_at, trigger_kind FROM cowork_schedules WHERE id = 's1'`);
    assert.strictEqual(rows[0].next_run_at, null);
    assert.strictEqual(rows[0].trigger_kind, 'app_event');
});

test('trigger_kind defaults to schedule', async () => {
    await pg.query(`INSERT INTO cowork_schedules (id, user_id, title, prompt, next_run_at) VALUES ('s2', 'u1', 't', 'p', NOW())`);
    const { rows } = await pg.query(`SELECT trigger_kind FROM cowork_schedules WHERE id = 's2'`);
    assert.strictEqual(rows[0].trigger_kind, 'schedule');
});

test('exactly one owner: none and both are refused', async () => {
    await assert.rejects(sub('none', null, null), /one_owner/);
    await assert.rejects(sub('both', 'a1', 's1'), /one_owner/);
});

test('a cowork subscription needs an existing schedule', async () => {
    await assert.rejects(sub('ghost', null, 'nope'), /foreign key|violates/i);
});

test('one run per (schedule, trigger_ref); runs without a ref are not limited', async () => {
    const run = (id, ref) => pg.query(
        `INSERT INTO cowork_runs (id, schedule_id, user_id, trigger_kind, trigger_ref) VALUES ($1, 's1', 'u1', 'mail', $2)`,
        [id, ref],
    );
    await run('r1', 'msg-1');
    await assert.rejects(run('r2', 'msg-1'), /duplicate key|unique/i);
    await run('r3', 'msg-2');
    await run('r4', null);
    await run('r5', null);
});

test('deleting the schedule deletes its subscriptions, not the automation ones', async () => {
    await pg.query(`DELETE FROM cowork_schedules WHERE id = 's1'`);
    const { rows } = await pg.query(`SELECT id FROM automation_event_subscriptions ORDER BY id`);
    assert.deepStrictEqual(rows.map((r) => r.id), ['old']);
});

test('is idempotent', async () => {
    await up();
    await up();
});

test('is registered in the automationStore migration list', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    assert.strictEqual(MIGRATIONS.filter((m) => m === 'agent-mail-trigger-2026-11').length, 1);
});
