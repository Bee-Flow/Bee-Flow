/**
 * Unit tests for the prompt-tasks → cowork move.
 *
 * The pg layer is faked via require.cache (same approach as
 * org-health-seed-2026-07.test.js), so no DB is needed. Every step of this
 * migration is a single INSERT/UPDATE, so the tests pin the CONTRACT of each
 * statement rather than the rows it happens to produce:
 *
 *   - ids and created_at are carried, not regenerated (notifications.task_id
 *     and the R3 routine-coverage memory both point at them)
 *   - only agent-less rows move; an agent routine stays in Studio → Routines
 *   - the source is deactivated, and only AFTER the copy — otherwise the copy
 *     inherits is_active = false and never runs
 *   - the synthetic history row is inserted already-closed, or
 *     coworkStore._closeOpenRun would attribute the next real result to it
 *   - re-running inserts nothing (NOT EXISTS keyed on the source id)
 *
 * Run: node --test server/migrations/prompt-tasks-to-cowork-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const state = { ops: [], rowCounts: {} };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// Which fake rowCount a statement reports, keyed by the table it writes to.
function rowCountFor(q) {
    if (q.startsWith('INSERT INTO cowork_schedules')) return state.rowCounts.schedules ?? 0;
    if (q.startsWith('INSERT INTO cowork_runs')) return state.rowCounts.runs ?? 0;
    if (q.startsWith('UPDATE ai_tasks')) return state.rowCounts.deactivated ?? 0;
    return 0;
}

const fakeDb = {
    async exec(sql) { state.ops.push({ kind: 'exec', sql: norm(sql) }); },
    async run(sql, params = []) {
        const q = norm(sql);
        state.ops.push({ kind: 'run', sql: q, params });
        return { rowCount: rowCountFor(q), rows: [] };
    },
    async getOne(sql, params = []) {
        const q = norm(sql);
        state.ops.push({ kind: 'getOne', sql: q, params });
        // to_regclass guard — both tables exist unless a test says otherwise.
        if (q.includes('to_regclass')) {
            const missing = state.missingTable && params[0] === `public.${state.missingTable}`;
            return { oid: missing ? null : params[0] };
        }
        return null;
    },
    async getAll() { return []; },
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { up, CARRIED_COLUMNS } = require('./prompt-tasks-to-cowork-2026-08');

const writes = () => state.ops.filter(o => o.kind === 'run');
const stmt = (prefix) => writes().find(o => o.sql.startsWith(prefix));
const scheduleInsert = () => stmt('INSERT INTO cowork_schedules');
const runInsert = () => stmt('INSERT INTO cowork_runs');
const deactivate = () => stmt('UPDATE ai_tasks');

test.beforeEach(() => {
    state.ops = [];
    state.rowCounts = { schedules: 3, runs: 2, deactivated: 3 };
    state.missingTable = null;
});

test('reports what it moved', async () => {
    const res = await up();
    assert.deepEqual(res, { migrated: 3, runsSeeded: 2, deactivated: 3 });
});

test('carries every column across, ids and created_at included', async () => {
    await up();
    const q = scheduleInsert().sql;
    for (const col of CARRIED_COLUMNS) {
        assert.ok(q.includes(`t.${col}`), `column ${col} is not selected from ai_tasks`);
    }
    // Regenerating either of these orphans notifications.task_id and the
    // routine-coverage memory rows that reference the task id.
    assert.ok(CARRIED_COLUMNS.includes('id'));
    assert.ok(CARRIED_COLUMNS.includes('created_at'));
});

test('only agent-less rows move — agent routines stay in Routines', async () => {
    await up();
    for (const op of [scheduleInsert(), runInsert(), deactivate()]) {
        assert.ok(
            op.sql.includes("(t.agent_id IS NULL OR t.agent_id = '')"),
            `statement is missing the agent-less filter: ${op.sql.slice(0, 60)}…`,
        );
    }
});

test('re-running inserts nothing: both inserts are guarded on the source id', async () => {
    await up();
    assert.ok(scheduleInsert().sql.includes(
        'NOT EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)',
    ));
    assert.ok(runInsert().sql.includes(
        "NOT EXISTS (SELECT 1 FROM cowork_runs r WHERE r.id = 'migrated-' || t.id)",
    ));
});

test('a deleted cowork twin stays deleted: the copy is gated on a stamp the twin cannot clear', async () => {
    await up();
    // NOT EXISTS alone cannot tell "never migrated" apart from "migrated, then
    // deleted by the user" — that ambiguity is what resurrected deleted
    // schedules on every boot. The permanent stamp on the source row can.
    assert.ok(writes()[0].sql.startsWith(
        'ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS migrated_to_cowork_at',
    ));
    assert.ok(scheduleInsert().sql.includes('t.migrated_to_cowork_at IS NULL'));
    const stamp = writes().filter(o => o.sql.startsWith('UPDATE ai_tasks'))[1];
    assert.ok(stamp.sql.includes('SET migrated_to_cowork_at = NOW()'));
    assert.ok(stamp.sql.includes('t.migrated_to_cowork_at IS NULL'));
    // Stamped only once a twin exists, so a pre-stamp database (twins made by
    // an earlier run of this migration) is caught up in the same pass.
    assert.ok(stamp.sql.includes('EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)'));
});

test('the source is deactivated only after the copy exists', async () => {
    await up();
    const order = writes().map(o => o.sql.split(' ').slice(0, 3).join(' '));
    assert.deepEqual(order, [
        'ALTER TABLE ai_tasks',      // migrated_to_cowork_at stamp column
        'INSERT INTO cowork_schedules',
        'INSERT INTO cowork_runs',
        'UPDATE ai_tasks t',         // deactivate
        'UPDATE ai_tasks t',         // stamp as migrated
    ]);
    // Ordering alone is not enough — the UPDATE must also only touch rows that
    // actually made it across, or a failed copy would pause the original too.
    assert.ok(deactivate().sql.includes(
        'EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)',
    ));
});

test('deactivating the source is what stops both runners double-firing', async () => {
    await up();
    assert.ok(deactivate().sql.includes('SET is_active = FALSE'));
    // Rows already paused are left alone, so the count means "newly stopped".
    assert.ok(deactivate().sql.includes('t.is_active = TRUE'));
});

test('the synthetic history row is closed, and only for tasks that ran', async () => {
    await up();
    const q = runInsert().sql;
    // finished_at is selected (as t.last_run_at) rather than left NULL: an open
    // row would swallow the result of the next real run.
    assert.ok(/t\.last_run_at, t\.last_run_at/.test(q), 'finished_at is not set from last_run_at');
    assert.ok(q.includes('t.last_run_at IS NOT NULL'), 'never-run tasks must not get a history row');
    assert.ok(q.includes("'migrated-' || t.id"), 'the run id must be derived from the source id');
});

test('a failed run carries its message as an error, not as a result', async () => {
    await up();
    const q = runInsert().sql;
    assert.ok(q.includes("CASE WHEN t.last_status = 'success' THEN t.last_result END"));
    assert.ok(q.includes("CASE WHEN t.last_status IN ('error', 'needs_reauth') THEN t.last_result END"));
});

test('does nothing at all when ai_tasks is not there yet', async () => {
    state.missingTable = 'ai_tasks';
    const res = await up();
    assert.deepEqual(res, { migrated: 0, runsSeeded: 0, deactivated: 0 });
    assert.equal(writes().length, 0);
});

test('does nothing at all when the cowork tables are not there yet', async () => {
    state.missingTable = 'cowork_schedules';
    const res = await up();
    assert.deepEqual(res, { migrated: 0, runsSeeded: 0, deactivated: 0 });
    assert.equal(writes().length, 0);
});
