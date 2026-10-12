/**
 * The Runs tab's list reads (handoff 5), run for real against PGlite:
 *   - the `q` search (summary, outcome sentence, starter name, trigger-payload
 *     STRING values, a run link), literal and parameterised;
 *   - the org log never searches payloads;
 *   - `startedBy` and `tests` narrow like every other filter;
 *   - the step-status, definition and pending-approval batch reads.
 *
 * Run: cd server && node --test stores/automationStore/runListing.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { buildRunFilterWhere } = require('./runs');
const { buildRunSearch, getJourneyStepStatuses, getVersionDefinitions, getPendingApprovalIdsForRuns } = require('./runListing');

const pg = new PGlite();
const query = async (sql, params) => (await pg.query(sql, params)).rows;

const RUN_LINK_ID = '0b9e2a8c-1f4d-4c55-9d4e-2f7a3c1b6e90';

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, "displayName" TEXT, "organizationId" TEXT);
        CREATE TABLE automations (id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT, kind TEXT DEFAULT 'automation', deleted_at TIMESTAMPTZ);
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, user_id TEXT, root_run_id TEXT,
            started_by_user_id TEXT, submitted_by_user_id TEXT, status TEXT, trigger_kind TEXT, mode TEXT DEFAULT 'live',
            summary TEXT, outcome_json JSONB, trigger_payload JSONB, is_test BOOLEAN NOT NULL DEFAULT FALSE,
            started_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT, step_id TEXT, parent_step_id TEXT, step_type TEXT, status TEXT, attempts INT DEFAULT 1,
            started_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE automation_versions (automation_id TEXT, version INT, definition_json JSONB, saved_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE automation_approvals (id TEXT PRIMARY KEY, run_id TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());

        INSERT INTO users VALUES ('u-anna', 'anna', 'Anna de Vries', 'org1'), ('u-bas', 'bas', 'Bas', 'org1');
        INSERT INTO automations VALUES ('a1', 'u-anna', 'org1');
        INSERT INTO automation_runs (id, automation_id, user_id, root_run_id, started_by_user_id, submitted_by_user_id, status, summary, outcome_json, trigger_payload, is_test, started_at) VALUES
            ('r1', 'a1', 'u-anna', 'r1', 'u-anna', NULL, 'success', 'List files', '{"code":"success","text":"List files: 23 files found in /"}', NULL, TRUE, NOW() - INTERVAL '5 minutes'),
            ('r2', 'a1', 'u-anna', 'r2', NULL, 'u-bas', 'success', 'Handled', NULL, '{"file":{"name":"Invoice-2026-001.pdf","size":10},"tags":["urgent"]}', FALSE, NOW() - INTERVAL '4 minutes'),
            ('r3', 'a1', 'u-anna', 'r3', NULL, NULL, 'error', '100% done_ok', NULL, '{"invoice_2026":"x"}', FALSE, NOW() - INTERVAL '3 minutes'),
            ('${RUN_LINK_ID}', 'a1', 'u-anna', '${RUN_LINK_ID}', NULL, NULL, 'awaiting_approval', NULL, NULL, NULL, FALSE, NOW() - INTERVAL '2 minutes'),
            -- r4's head says success; its continuation (r4b) is what the list shows.
            ('r4', 'a1', 'u-anna', 'r4', NULL, NULL, 'success', 'Resumed', NULL, NULL, FALSE, NOW() - INTERVAL '1 minutes'),
            ('r4b', 'a1', 'u-anna', 'r4', NULL, NULL, 'awaiting_approval', 'Waiting', '{"code":"waiting_approval","text":"Waiting for approval from Finance"}', NULL, FALSE, NOW());

        INSERT INTO automation_run_steps (run_id, step_id, parent_step_id, step_type, status, attempts, started_at) VALUES
            ('r4', 's1', NULL, 'integration_action', 'success', 1, NOW() - INTERVAL '50 seconds'),
            ('r4b', 's2', NULL, 'approval', 'awaiting_approval', 1, NOW()),
            ('r1', 's1', NULL, 'integration_action', 'error', 1, NOW() - INTERVAL '5 minutes'),
            ('r1', 's1', NULL, 'integration_action', 'success', 2, NOW() - INTERVAL '5 minutes');
        INSERT INTO automation_versions VALUES
            ('a1', 3, '{"steps":[{"id":"old"}]}', NOW() - INTERVAL '1 day'),
            ('a1', 3, '{"steps":[{"id":"s1"}]}', NOW()),
            ('a1', 4, '{"steps":[]}', NOW());
        INSERT INTO automation_approvals VALUES ('ap-old', 'r4b', 'approved', NOW() - INTERVAL '1 hour'), ('ap1', 'r4b', 'pending', NOW());
    `);
});

after(async () => { await pg.close(); });

const LATERAL = `LEFT JOIN LATERAL (
    SELECT l.id, l.status, l.summary, l.outcome_json FROM automation_runs l
     WHERE COALESCE(l.root_run_id, l.id) = COALESCE(r.root_run_id, r.id)
     ORDER BY l.started_at DESC NULLS LAST, l.id DESC LIMIT 1) j ON TRUE`;

async function ids(scope, filters = {}) {
    const w = buildRunFilterWhere(scope, filters, 1);
    const joins = `JOIN automations a ON a.id = r.automation_id${w.joinUsers ? ' LEFT JOIN users u ON u.id = a.user_id' : ''}`;
    const rows = await query(`SELECT r.id FROM automation_runs r ${joins} ${LATERAL} WHERE ${w.clause} ORDER BY r.id`, w.params);
    return rows.map(x => x.id);
}
const A1 = { automation: { automationId: 'a1' } };

test('q: the outcome sentence, the summary of the newest leg, and the starter\'s name', async () => {
    assert.deepStrictEqual(await ids(A1, { q: '23 files' }), ['r1']);
    assert.deepStrictEqual(await ids(A1, { q: 'from finance' }), ['r4'], 'the continuation\'s outcome is the journey\'s');
    assert.deepStrictEqual(await ids(A1, { q: 'resumed' }), [], 'the head\'s stale summary is not what the row shows');
    assert.deepStrictEqual(await ids(A1, { q: 'de vries' }), ['r1']);
    assert.deepStrictEqual(await ids(A1, { q: 'BAS' }), ['r2'], 'the person who filled in the form counts too');
});

test('q: trigger-payload STRING values at any depth, never keys', async () => {
    assert.deepStrictEqual(await ids(A1, { q: 'invoice-2026' }), ['r2']);
    assert.deepStrictEqual(await ids(A1, { q: 'urgent' }), ['r2']);
    assert.deepStrictEqual(await ids(A1, { q: 'invoice_2026' }), [], 'a key is not a value');
});

test('q: matched literally (% and _ are not wildcards), bounded, and a run link finds its run', async () => {
    assert.deepStrictEqual(await ids(A1, { q: '100%' }), ['r3']);
    assert.deepStrictEqual(await ids(A1, { q: 'done_ok' }), ['r3']);
    assert.deepStrictEqual(await ids(A1, { q: 'done%ok' }), []);
    assert.deepStrictEqual(await ids(A1, { q: `https://x/app/automations/a1/runs/${RUN_LINK_ID.toUpperCase()}` }), [RUN_LINK_ID]);
    assert.strictEqual(buildRunSearch('   ', 1), null);
    assert.strictEqual(buildRunSearch('x'.repeat(500), 1).params[0].length, 102, 'the term is capped at 100 characters');
});

test('q on the org log: no payload search', async () => {
    assert.deepStrictEqual(await ids({ org: { orgId: 'org1' } }, { q: '23 files' }), ['r1']);
    assert.deepStrictEqual(await ids({ org: { orgId: 'org1' } }, { q: 'invoice-2026' }), []);
});

test('startedBy and tests narrow the scope', async () => {
    assert.deepStrictEqual(await ids(A1, { startedBy: 'u-anna' }), ['r1']);
    assert.deepStrictEqual(await ids(A1, { startedBy: 'u-bas' }), ['r2']);
    assert.deepStrictEqual(await ids(A1, { tests: 'only' }), ['r1']);
    assert.deepStrictEqual(await ids(A1, { tests: 'exclude' }), [RUN_LINK_ID, 'r2', 'r3', 'r4']);
    assert.deepStrictEqual(await ids(A1, { tests: 'exclude', q: '23 files' }), []);
});

test('getJourneyStepStatuses: every leg\'s rows, under the journey root, attempts in order', async () => {
    const map = await getJourneyStepStatuses(['r4', 'r1', 'none'], { query });
    assert.deepStrictEqual(map.get('r4').map(r => [r.stepId, r.status]), [['s1', 'success'], ['s2', 'awaiting_approval']]);
    assert.deepStrictEqual(map.get('r1').map(r => [r.stepId, r.status, r.attempts]), [['s1', 'error', 1], ['s1', 'success', 2]]);
    assert.strictEqual(map.has('none'), false);
    assert.strictEqual((await getJourneyStepStatuses([], { query })).size, 0);
});

test('getVersionDefinitions: the newest snapshot per (automation, version)', async () => {
    const map = await getVersionDefinitions([{ automationId: 'a1', version: 3 }, { automationId: 'a1', version: 3 }, { automationId: 'a1', version: 9 }], { query });
    assert.deepStrictEqual(map.get('a1@3'), { steps: [{ id: 's1' }] });
    assert.strictEqual(map.has('a1@9'), false);
});

test('getPendingApprovalIdsForRuns: the pending one only', async () => {
    const map = await getPendingApprovalIdsForRuns(['r4b', 'r1'], { query });
    assert.deepStrictEqual([...map.entries()], [['r4b', 'ap1']]);
});
