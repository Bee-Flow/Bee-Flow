// @typecheck
/**
 * The sandbox-seat columns of automation_approvals and the reaper sweeps that
 * skip them: a test approval is never reminded or escalated, a production
 * one exactly as before. Against a real Postgres (pglite).
 *
 * Run: cd server && node --test stores/automationStore/approvalSandbox.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeApprovalSweeps, sandboxFields, sandboxParams } = require('./approvalSandbox.mts');
const migration = require('../../migrations/automation-run-profile-2026-11');

const { pg, db } = pgliteDb();
const sweeps = makeApprovalSweeps(db, (r) => ({ id: r.id, ...sandboxFields(r) }));

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_pages (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_sessions (id TEXT PRIMARY KEY);
        CREATE TABLE automation_approvals (
            id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TIMESTAMPTZ,
            remind_at TIMESTAMPTZ, reminder_sent_at TIMESTAMPTZ,
            escalate_at TIMESTAMPTZ, escalated_at TIMESTAMPTZ,
            escalate_to_user_id TEXT, escalate_to_group_id TEXT
        );
    `);
    await migration.up({ exec: (sql) => pg.exec(sql) });
    const due = `NOW() - INTERVAL '1 minute'`;
    for (const [id, isTest] of [['apr_prod', null], ['apr_test', true]]) {
        await pg.query(
            `INSERT INTO automation_approvals (id, status, remind_at, escalate_at, escalate_to_user_id, is_test, sandbox_user_id, configured_routing)
             VALUES ($1, 'pending', ${due}, ${due}, 'u9', $2, $3, $4)`,
            [id, ...sandboxParams({ isTest: !!isTest, sandboxUserId: 'tester', configuredRouting: { runKind: 'test', stages: null } })],
        );
    }
});
after(async () => { await pg.close(); });

test('the reminder sweep claims the production row and never the test row', async () => {
    const due = await sweeps.markDueApprovalReminders();
    assert.deepEqual(due.map((r) => r.id), ['apr_prod']);
    assert.deepEqual(await sweeps.markDueApprovalReminders(), [], 'claimed once');
});

test('the escalation sweep likewise', async () => {
    const due = await sweeps.markDueApprovalEscalations();
    assert.deepEqual(due.map((r) => r.id), ['apr_prod']);
});

test('the columns map back: is_test, the tester and the configured routing', async () => {
    const { rows } = await db.query(`SELECT * FROM automation_approvals WHERE id = 'apr_test'`);
    assert.deepEqual(sandboxFields(rows[0]), { isTest: true, sandboxUserId: 'tester', configuredRouting: { runKind: 'test', stages: null } });
    const prod = (await db.query(`SELECT * FROM automation_approvals WHERE id = 'apr_prod'`)).rows[0];
    assert.deepEqual(sandboxFields(prod), { isTest: false, sandboxUserId: null, configuredRouting: null });
});

test('sandboxParams writes nothing for a production row', () => {
    assert.deepEqual(sandboxParams({ isTest: false, sandboxUserId: 'x', configuredRouting: { a: 1 } }), [null, null, null]);
    assert.deepEqual(sandboxParams({ isTest: true, sandboxUserId: 'tester', configuredRouting: { a: 1 } }), [true, 'tester', '{"a":1}']);
});
