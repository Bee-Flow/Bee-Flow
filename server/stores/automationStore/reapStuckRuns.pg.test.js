/**
 * reapStuckRuns against a real Postgres (PGlite): a run row that never left
 * 'queued' is reaped too.
 *
 * A run row is created 'queued' and becomes 'running' only once the run holds
 * the automation's marker — which a webhook or event run may wait five minutes
 * for (runHeartbeat.acquireRunMarker). A worker that dies in that stretch
 * (every deploy is a chance) leaves the row 'queued' for good: the reaper only
 * looked at 'running', retention never deletes an in-flight row, the row sits
 * in the active-runs list, and it keeps reapStuckAutomations' repair clause
 * from ever firing for its automation (that clause requires that no run is
 * running or queued).
 *
 * A queued row has no heartbeat, so it gets its own, longer window: the
 * longest a run may legitimately wait for the marker, plus the stale window.
 *
 * Run: cd server && node --test stores/automationStore/reapStuckRuns.pg.test.js
 */

'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { reapStuckRuns } = require('./automations');

before(async () => {
    await require('./core').initDB();
    await pg.query(
        `INSERT INTO automations (id, user_id, title, definition_json, version, is_active, is_draft, needs_first_run_confirm, trigger_type)
         VALUES ('auto-1', 'u1', 'reaper-test', '{}'::jsonb, 1, TRUE, FALSE, FALSE, 'webhook')`,
    );
});
after(close);
afterEach(async () => { await pg.exec('DELETE FROM automation_runs'); });

async function seedRun(id, status, { startedAgo, heartbeatAgo = null }) {
    await pg.query(
        `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status, started_at, last_heartbeat_at, root_run_id)
         VALUES ($1, 'auto-1', 1, 'u1', 'webhook', 'live', $2, NOW() - ($3::int * INTERVAL '1 second'),
                 CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4::int * INTERVAL '1 second') END, $1)`,
        [id, status, startedAgo, heartbeatAgo],
    );
}
const statusOf = async (id) => (await pg.query('SELECT status, error_class FROM automation_runs WHERE id = $1', [id])).rows[0];

const WINDOWS = { staleAfterMs: 6 * 60_000, queuedStaleAfterMs: 11 * 60_000 };

test('a run stuck in "queued" past its window is failed', async () => {
    await seedRun('q-old', 'queued', { startedAgo: 3600 });
    const reaped = await reapStuckRuns(WINDOWS);
    assert.deepStrictEqual(reaped.map(r => r.id), ['q-old'], 'a queued row whose worker died is never cleaned up');
    assert.deepStrictEqual(await statusOf('q-old'), { status: 'error', error_class: 'RunnerDied' });
});

test('a run still waiting for the marker is left alone', async () => {
    // Older than the running window, younger than the queued one: a webhook
    // run that has been waiting for a busy automation for eight minutes.
    await seedRun('q-waiting', 'queued', { startedAgo: 8 * 60 });
    assert.deepStrictEqual(await reapStuckRuns(WINDOWS), []);
    assert.strictEqual((await statusOf('q-waiting')).status, 'queued');
});

test('running rows keep their heartbeat rule', async () => {
    await seedRun('r-dead', 'running', { startedAgo: 3600, heartbeatAgo: 600 });
    await seedRun('r-alive', 'running', { startedAgo: 3600, heartbeatAgo: 10 });
    const reaped = await reapStuckRuns(WINDOWS);
    assert.deepStrictEqual(reaped.map(r => r.id), ['r-dead']);
    assert.strictEqual((await statusOf('r-alive')).status, 'running');
});

test('without a queued window the default still covers the default marker wait', async () => {
    await seedRun('q-7min', 'queued', { startedAgo: 7 * 60 });
    await seedRun('q-1h', 'queued', { startedAgo: 3600 });
    const reaped = await reapStuckRuns();
    assert.deepStrictEqual(reaped.map(r => r.id), ['q-1h']);
});
