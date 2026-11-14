// @typecheck
/**
 * The prompt-tasks → cowork move, on a real Postgres: the boot ladder's
 * schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool
 * (testUtils/pglitePool.js). What the tests hold the migration to:
 *
 *   - ids and created_at are carried, not regenerated (notifications.task_id
 *     and the R3 routine-coverage memory both point at them)
 *   - only agent-less rows move; an agent routine stays in Studio → Routines
 *   - the source is deactivated, and only AFTER the copy — otherwise the copy
 *     inherits is_active = false and never runs
 *   - the synthetic history row is inserted already-closed, or
 *     coworkStore._closeOpenRun would attribute the next real result to it
 *   - re-running inserts nothing, and a twin the user deleted stays deleted
 *
 * Run: node --test server/migrations/prompt-tasks-to-cowork-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { hideTable } = require('../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const { up, CARRIED_COLUMNS } = require('./prompt-tasks-to-cowork-2026-08');
test.after(close);

test.beforeEach(async () => {
    await pg.exec('TRUNCATE cowork_runs, cowork_schedules CASCADE; TRUNCATE ai_tasks');
});

const CREATED = '2025-03-04T05:06:07.000Z';
/** @param {string} id @param {Record<string, unknown>} [over] */
const task = (id, over = {}) => insertRow(pg, 'ai_tasks', {
    id, user_id: 'u1', title: `t ${id}`, prompt: 'p', next_run_at: '2026-12-01T00:00:00Z', is_active: true,
    created_at: CREATED, repeat_interval: 'daily', run_count: 4, timezone: 'Europe/Amsterdam', ...over,
});
/** @param {string} t */
const all = async (t) => (await pg.query(`SELECT * FROM ${t} ORDER BY id`)).rows;

test('reports what it moved', async () => {
    await task('a', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'success', last_result: 'ok' });
    await task('b', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'error', last_result: 'boom' });
    await task('c');
    await task('agent', { agent_id: 'ag1' });
    assert.deepEqual(await up(), { migrated: 3, runsSeeded: 2, deactivated: 3 });
});

test('carries every column across, ids and created_at included', async () => {
    const src = await task('a', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'success', last_result: 'ok', days_of_week: '1,3', time_of_day: '09:00', model_tier: 'fast', tools_enabled: 'web', max_result_length: 900, conversation_id: 'c9' });
    await up();
    const [copy] = await all('cowork_schedules');
    for (const col of CARRIED_COLUMNS) {
        if (col === 'is_active') continue;
        assert.deepStrictEqual(copy[col], src[col], `column ${col} carried`);
    }
    assert.strictEqual(new Date(copy.created_at).toISOString(), CREATED, 'created_at is the original, not now');
    assert.strictEqual(copy.is_active, true, 'the copy runs: it was made before the original was paused');
});

test('only agent-less rows move — agent routines stay in Routines', async () => {
    await task('null-agent', { agent_id: null, last_run_at: '2026-10-01T00:00:00Z' });
    await task('empty-agent', { agent_id: '', last_run_at: '2026-10-01T00:00:00Z' });
    await task('agent', { agent_id: 'ag1', last_run_at: '2026-10-01T00:00:00Z' });
    await up();
    assert.deepEqual((await all('cowork_schedules')).map(r => r.id), ['empty-agent', 'null-agent']);
    assert.deepEqual((await all('cowork_runs')).map(r => r.schedule_id), ['empty-agent', 'null-agent']);
    const agent = (await all('ai_tasks')).find(r => r.id === 'agent');
    assert.deepEqual([agent.is_active, agent.migrated_to_cowork_at], [true, null], 'the agent routine is untouched');
});

test('re-running inserts nothing', async () => {
    await task('a', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'success' });
    await up();
    assert.deepEqual(await up(), { migrated: 0, runsSeeded: 0, deactivated: 0 });
    assert.equal((await all('cowork_schedules')).length, 1);
    assert.equal((await all('cowork_runs')).length, 1);
});

test('a deleted cowork twin stays deleted: the stamp on the source, not the twin\'s absence, gates the copy', async () => {
    await task('a');
    await up();
    assert.ok((await all('ai_tasks'))[0].migrated_to_cowork_at, 'stamped once the twin exists');
    await pg.query("DELETE FROM cowork_schedules WHERE id = 'a'");
    await pg.query("UPDATE ai_tasks SET is_active = TRUE WHERE id = 'a'");
    await up();
    assert.equal((await all('cowork_schedules')).length, 0, 'not resurrected');
});

test('a pre-stamp database (twin made by an earlier run) is stamped and paused in one pass', async () => {
    await task('a');
    await insertRow(pg, 'cowork_schedules', { id: 'a', user_id: 'u1', title: 'twin', prompt: 'p' });
    const res = await up();
    assert.equal(res.migrated, 0, 'the twin is not copied over');
    const [src] = await all('ai_tasks');
    assert.ok(src.migrated_to_cowork_at);
    assert.strictEqual(src.is_active, false);
    assert.strictEqual((await all('cowork_schedules'))[0].title, 'twin');
});

test('the source is paused only when its copy exists; rows already paused are not counted', async () => {
    await task('a');
    await task('paused', { is_active: false });
    // Stamped earlier, its twin deleted since: no copy is made, so it must not be paused either.
    await task('no-copy', { migrated_to_cowork_at: '2026-01-01T00:00:00Z' });
    const res = await up();
    assert.equal(res.deactivated, 1, 'only the newly stopped row counts');
    const rows = await all('ai_tasks');
    assert.deepEqual(rows.map(r => [r.id, r.is_active]), [['a', false], ['no-copy', true], ['paused', false]]);
});

test('the synthetic history row is closed, and only for tasks that ran', async () => {
    await task('ran', { last_run_at: '2026-10-01T08:00:00Z', last_status: 'success', last_result: 'done' });
    await task('never');
    await up();
    const runs = await all('cowork_runs');
    assert.equal(runs.length, 1, 'never-run tasks get no history row');
    const [r] = runs;
    assert.equal(r.id, 'migrated-ran', 'the run id is derived from the source id');
    assert.equal(r.schedule_id, 'ran');
    assert.equal(r.trigger_kind, 'schedule');
    assert.equal(new Date(r.started_at).toISOString(), '2026-10-01T08:00:00.000Z');
    assert.equal(new Date(r.finished_at).toISOString(), '2026-10-01T08:00:00.000Z', 'closed: an open row would swallow the next real result');
    assert.equal(r.status, 'success');
});

test('a failed run carries its message as an error, not as a result', async () => {
    await task('ok', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'success', last_result: 'fine' });
    await task('err', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'error', last_result: 'boom' });
    await task('reauth', { last_run_at: '2026-10-01T00:00:00Z', last_status: 'needs_reauth', last_result: 'sign in' });
    await task('nostatus', { last_run_at: '2026-10-01T00:00:00Z', last_status: null, last_result: 'x' });
    await up();
    const by = Object.fromEntries((await all('cowork_runs')).map(r => [r.schedule_id, [r.status, r.result, r.error]]));
    assert.deepEqual(by, {
        ok: ['success', 'fine', null],
        err: ['error', null, 'boom'],
        reauth: ['needs_reauth', null, 'sign in'],
        nostatus: ['success', null, null],
    });
});

test('does nothing at all when ai_tasks is not there yet', async () => {
    const show = await hideTable(pg, 'ai_tasks');
    try {
        assert.deepEqual(await up(), { migrated: 0, runsSeeded: 0, deactivated: 0 });
    } finally { await show(); }
});

test('does nothing at all when the cowork tables are not there yet', async () => {
    await task('a');
    const show = await hideTable(pg, 'cowork_schedules');
    try {
        assert.deepEqual(await up(), { migrated: 0, runsSeeded: 0, deactivated: 0 });
    } finally { await show(); }
    const [src] = await all('ai_tasks');
    assert.deepEqual([src.is_active, src.migrated_to_cowork_at], [true, null]);
});
