// @typecheck
/**
 * The agent-routines → cowork move: the same four statements as the prompt-task
 * move (tested in prompt-tasks-to-cowork-2026-08.test.js), aimed at the rows
 * that one left behind. On a real Postgres (the boot ladder's schema on PGlite
 * behind db.js's pool).
 *
 * Run: node --test server/migrations/agent-tasks-to-cowork-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const { up, AGENT_TASK } = require('./agent-tasks-to-cowork-2026-10');
const { PLAIN_TASK } = require('./prompt-tasks-to-cowork-2026-08');
test.after(close);

/** @param {string} id @param {string | null} agentId */
const task = (id, agentId) => insertRow(pg, 'ai_tasks', {
    id, user_id: 'u1', title: id, prompt: 'p', next_run_at: '2026-12-01T00:00:00Z', is_active: true,
    agent_id: agentId, last_run_at: '2026-10-01T00:00:00Z', last_status: 'success',
});
/** @param {string} t */
const ids = async (t) => (await pg.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map(r => r.id);

test('moves exactly the agent-linked rows, never the plain ones', async () => {
    assert.strictEqual(AGENT_TASK, `NOT ${PLAIN_TASK}`);
    await task('agent', 'ag1');
    await task('plain-null', null);
    await task('plain-empty', '');
    assert.deepEqual(await up(), { migrated: 1, runsSeeded: 1, deactivated: 1 });
    assert.deepEqual(await ids('cowork_schedules'), ['agent']);
    assert.deepEqual(await ids('cowork_runs'), ['migrated-agent']);
    const { rows } = await pg.query('SELECT id, is_active, migrated_to_cowork_at IS NOT NULL AS stamped FROM ai_tasks ORDER BY id');
    assert.deepEqual(rows, [
        { id: 'agent', is_active: false, stamped: true },
        { id: 'plain-empty', is_active: true, stamped: false },
        { id: 'plain-null', is_active: true, stamped: false },
    ]);
});

test('ids are carried and the stamp keeps a deleted cowork twin from coming back', async () => {
    await pg.query("DELETE FROM cowork_schedules WHERE id = 'agent'");
    await up();
    assert.deepEqual(await ids('cowork_schedules'), [], 'the stamped source is not copied again');
});
