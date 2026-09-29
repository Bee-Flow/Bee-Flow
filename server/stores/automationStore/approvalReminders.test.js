/**
 * The "send reminder" rate limit (handoff 5): one manual reminder per approval
 * per window, recorded in the approval's audit log, run for real against
 * PGlite so the SQL and the transaction are proven, not just their shape.
 *
 * Run: cd server && node --test stores/automationStore/approvalReminders.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { claimApprovalReminder } = require('./approvalReminders');

const pg = new PGlite();
const deps = { getClient: async () => ({ query: (sql, params) => pg.query(sql, params), release: () => {} }) };

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_approvals (id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, status TEXT NOT NULL);
        CREATE TABLE automation_approval_audit (
            id TEXT PRIMARY KEY, approval_id TEXT, run_id TEXT, step_id TEXT, decided_by TEXT,
            decision TEXT NOT NULL, comment TEXT, source TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO automation_approvals VALUES
            ('ap1', 'run1', 's4', 'pending'),
            ('ap2', 'run2', 's4', 'approved'),
            ('ap3', 'run3', 's4', 'pending');
        -- ap3 was reminded 11 minutes ago: outside the window.
        INSERT INTO automation_approval_audit (id, approval_id, decision, source, ts)
            VALUES ('old', 'ap3', 'reminded', 'manual', NOW() - INTERVAL '11 minutes');
    `);
});

after(async () => { await pg.close(); });

test('the first reminder is claimed and logged; a second inside 10 minutes is refused with when it may go', async () => {
    const first = await claimApprovalReminder('ap1', { byUserId: 'owner' }, deps);
    assert.strictEqual(first.claimed, true);
    const logged = await pg.query(`SELECT decided_by, decision, source, run_id, step_id FROM automation_approval_audit WHERE approval_id = 'ap1'`);
    assert.deepStrictEqual(logged.rows, [{ decided_by: 'owner', decision: 'reminded', source: 'manual', run_id: 'run1', step_id: 's4' }]);

    const second = await claimApprovalReminder('ap1', { byUserId: 'someone-else' }, deps);
    assert.strictEqual(second.claimed, false);
    assert.strictEqual(second.reason, 'rate_limited');
    assert.strictEqual(new Date(second.nextAt).getTime() - new Date(second.lastAt).getTime(), 10 * 60_000);
    const count = await pg.query(`SELECT COUNT(*)::int AS n FROM automation_approval_audit WHERE approval_id = 'ap1'`);
    assert.strictEqual(count.rows[0].n, 1, 'a refused reminder leaves no trace');
});

test('a reminder older than the window does not block the next one', async () => {
    const claim = await claimApprovalReminder('ap3', { byUserId: 'owner' }, deps);
    assert.strictEqual(claim.claimed, true);
});

test('a decided approval is not reminded', async () => {
    const claim = await claimApprovalReminder('ap2', { byUserId: 'owner' }, deps);
    assert.deepStrictEqual(claim, { claimed: false, reason: 'not_pending' });
});

test('the window is configurable, and never below a minute', async () => {
    await pg.exec(`INSERT INTO automation_approvals VALUES ('ap4', 'run4', 's4', 'pending');
                   INSERT INTO automation_approval_audit (id, approval_id, decision, source, ts)
                       VALUES ('recent', 'ap4', 'reminded', 'manual', NOW() - INTERVAL '3 minutes');`);
    assert.strictEqual((await claimApprovalReminder('ap4', { windowMinutes: 5 }, deps)).claimed, false);
    assert.strictEqual((await claimApprovalReminder('ap4', { windowMinutes: 2 }, deps)).claimed, true);
});
