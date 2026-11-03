// @typecheck
/**
 * The run row carries its profile: createRun stores it in run_profile, rowToRun
 * hands the stored one back (NULL on a legacy row), and profileOfRun derives a
 * legacy row's profile from its columns. Against a real Postgres (pglite).
 *
 * Run: cd server && node --test stores/automationStore/runs.profile.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { createRunWith } = require('./runs');
const { rowToRun } = require('./rowMappers');
const { profileFor, profileOfRun } = require('../../core/automationModel/runProfile.mts');
const migration = require('../../migrations/automation-run-profile-2026-11');

const { pg, db } = pgliteDb();
const run = (/** @type {string} */ sql, /** @type {unknown[]} */ params) => db.query(sql, params);
const read = async (/** @type {string} */ id) => rowToRun((await pg.query('SELECT * FROM automation_runs WHERE id = $1', [id])).rows[0]);

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, version INTEGER, user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL, trigger_payload JSONB, mode TEXT NOT NULL DEFAULT 'live', status TEXT NOT NULL,
            started_at TIMESTAMPTZ, parent_run_id TEXT, root_run_id TEXT, root_step_id TEXT,
            is_test BOOLEAN NOT NULL DEFAULT FALSE, started_by_user_id TEXT, caller_agent_id TEXT,
            caller_conversation_id TEXT, connections_mode TEXT
        );
        CREATE TABLE automation_approvals (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_pages (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_sessions (id TEXT PRIMARY KEY);
    `);
    await migration.up({ exec: (sql) => pg.exec(sql) });
});
after(async () => { await pg.close(); });

test('createRun stores the profile and rowToRun hands it back', async () => {
    const profile = profileFor({ mode: 'live', triggerKind: 'manual_step', startedByUserId: 'u1', partial: { mode: 'only', targetStepId: 'appr' } }, {});
    const id = await createRunWith(run, {
        automationId: 'a1', version: 2, userId: 'owner', triggerKind: 'manual_step', mode: 'live',
        isTest: true, startedByUserId: 'u1', runProfile: profile,
    });
    const row = await read(id);
    assert.deepEqual(row?.profile, profile);
    assert.deepEqual(profileOfRun(row), profile);
    assert.equal(row?.isTest, true);
});

test('a row without a profile reads back null and derives the legacy one', async () => {
    const id = await createRunWith(run, { automationId: 'a1', version: 1, userId: 'owner', triggerKind: 'webhook', mode: 'live' });
    const row = await read(id);
    assert.equal(row?.profile, null);
    const derived = profileOfRun(row);
    assert.equal(derived.kind, 'production');
    assert.equal(derived.holdsMarker, true);
    assert.deepEqual(derived.approverSeat, { kind: 'configured' });
});
