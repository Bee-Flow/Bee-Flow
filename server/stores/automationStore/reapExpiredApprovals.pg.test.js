/**
 * The approval reaper's claim (automations.js reapExpiredApprovals) against a real Postgres
 * (PGlite): a run past its approval deadline is closed as ApprovalExpired exactly as before,
 * and the reaper is now also told which step it was waiting on (approvalExpiry.mts continues
 * an approval with an expired branch from there). A run still inside its window, or not
 * waiting, is left alone; a second reap finds nothing.
 *
 * Run: cd server && node --test stores/automationStore/reapExpiredApprovals.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { reapExpiredApprovals } = require('./automations');

before(async () => {
    await require('./core').initDB();
    await pg.exec(`INSERT INTO automations (id, user_id, title, definition_json) VALUES ('au1', 'owner', 'Gate', '{}')`);
    await pg.exec(`
        INSERT INTO automation_runs (id, automation_id, version, trigger_kind, user_id, status, started_at, awaiting_step_id, approval_token, awaiting_step_expires_at)
        VALUES ('late', 'au1', 1, 'manual', 'owner', 'awaiting_approval', NOW() - INTERVAL '2 days', 'ap', 'tok-1', NOW() - INTERVAL '1 hour'),
               ('waiting', 'au1', 1, 'manual', 'owner', 'awaiting_approval', NOW(), 'ap', 'tok-2', NOW() + INTERVAL '1 day'),
               ('done', 'au1', 1, 'manual', 'owner', 'success', NOW(), NULL, NULL, NOW() - INTERVAL '1 hour')`);
});
after(close);

test('an expired approval run is closed as before and comes back with the step it waited on', async () => {
    const reaped = await reapExpiredApprovals();
    assert.deepStrictEqual(reaped, [{ id: 'late', automationId: 'au1', userId: 'owner', awaitingStepId: 'ap' }]);
    const row = (await pg.query(`SELECT status, error_class, error, summary, awaiting_step_id, approval_token, finished_at, duration_ms FROM automation_runs WHERE id = 'late'`)).rows[0];
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.error_class, 'ApprovalExpired');
    assert.strictEqual(row.error, 'Approval was not granted before the deadline');
    assert.strictEqual(row.summary, 'Approval expired — no decision was made before the deadline.');
    assert.strictEqual(row.awaiting_step_id, null);
    assert.strictEqual(row.approval_token, null);
    assert.ok(row.finished_at);
    assert.ok(row.duration_ms > 0);

    const others = (await pg.query(`SELECT id, status, awaiting_step_id FROM automation_runs WHERE id <> 'late' ORDER BY id`)).rows;
    assert.deepStrictEqual(others, [{ id: 'done', status: 'success', awaiting_step_id: null }, { id: 'waiting', status: 'awaiting_approval', awaiting_step_id: 'ap' }]);
    assert.deepStrictEqual(await reapExpiredApprovals(), [], 'claimed once');
});
