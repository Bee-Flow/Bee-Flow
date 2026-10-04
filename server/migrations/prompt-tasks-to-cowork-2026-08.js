#!/usr/bin/env node
/**
 * Data migration: move plain prompt tasks out of `ai_tasks` into Cowork.
 *
 * Prompt tasks and cowork schedules are the same idea built twice. The tables
 * are column-for-column identical (compare aiTaskStore.initDB with
 * cowork-2026-08.js), the same `aiTaskRunner.executeTask` drives both — cowork
 * just injects a different store — and the two surfaces even shared a quota.
 * The only real difference is that cowork keeps a row per execution, which is
 * the thing prompt tasks were missing. So this is a move, not a conversion.
 *
 * MOVE, NOT COPY. Both runners are started unconditionally (server/index.js)
 * and poll their own table with the same `next_run_at <= NOW()` predicate. A
 * row left live in both places is picked up by both loops inside the same
 * minute: two LLM calls, two notifications, double the tokens. Step 3 below
 * deactivates every source row it copied, and it runs last so the copy
 * inherits the schedule's real is_active.
 *
 * WHAT MOVES: agent-less rows only. An `agent_id` sends executeTask down the
 * agent-runtime path, those are created and managed from the Agent Wizard, and
 * they stay listed under Studio → Routines. Cowork's editor has no equivalent
 * of that surface, so dragging them across would lose it.
 *
 * IDS ARE PRESERVED. `notifications.task_id` and the R3 routine-coverage memory
 * (memoryStore.upsertRoutineCoverage, keyed on the task id in aiTaskRunner)
 * both point at these ids. Re-keying would orphan them.
 *
 * HISTORY. A prompt task only ever kept its *last* result, so there is exactly
 * one run to carry over, and only for tasks that ever ran. It is inserted
 * already-closed (`finished_at` set): coworkStore._closeOpenRun picks the
 * newest row with a NULL finished_at, so an open synthetic row would swallow
 * the result of the next real run. `duration_ms` stays NULL — it was never
 * recorded. `run_count` is copied verbatim, so a long-lived task can read "37
 * runs" above a single history row; that is the honest version.
 *
 * Idempotent: the copy is guarded by a permanent `migrated_to_cowork_at` stamp
 * on the source row (step 4) plus NOT EXISTS on the target id, and the
 * deactivation only touches rows that already have a cowork twin. The stamp —
 * not the twin's existence — is what makes re-runs safe: keying only on
 * NOT EXISTS meant a schedule the user deleted from Cowork was re-copied from
 * its retained source row on every boot, forever. Auto-runs from server boot.
 * Manual usage:
 *   node server/migrations/prompt-tasks-to-cowork-2026-08.js
 */

const { getOne, run } = require('../db');

// Shared by the insert and its SELECT, in the same order, so the two can never
// drift apart. `id` and `created_at` are listed explicitly: the point is to
// carry them over rather than let the column defaults invent new ones.
const CARRIED_COLUMNS = [
    'id', 'user_id', 'title', 'prompt', 'repeat_interval', 'days_of_week',
    'time_of_day', 'next_run_at', 'last_run_at', 'last_result', 'last_status',
    'is_active', 'model_tier', 'tools_enabled', 'max_result_length',
    'run_count', 'timezone', 'agent_id', 'conversation_id', 'created_at',
];

// Only migrate rows that are genuinely agent-less. `agent_id = ''` shows up in
// older rows written before the routes normalised the empty string to NULL.
const PLAIN_TASK = `(t.agent_id IS NULL OR t.agent_id = '')`;

async function tableExists(name) {
    const r = await getOne(`SELECT to_regclass($1) AS oid`, [`public.${name}`]);
    return !!r?.oid;
}

/**
 * Move the `ai_tasks` rows that match `where` (SQL over alias `t`) into Cowork:
 * copy, seed the one history row, pause the original, stamp it. Shared with
 * agent-tasks-to-cowork-2026-10, which moves the agent-linked rows the same way.
 * @param {{ where: string, label: string }} opts
 */
async function moveTasksToCowork({ where, label }) {
    // Force both schemas into existence first. coworkStore applies its own DDL
    // on import, and `npm run db:migrate` loads stores rather than migrations,
    // so requiring it is also what guarantees the target tables are there.
    await require('../stores/coworkStore');
    await require('../stores/aiTaskStore');

    if (!await tableExists('ai_tasks') || !await tableExists('cowork_schedules')) {
        return { migrated: 0, runsSeeded: 0, deactivated: 0 };
    }

    // The stamp lives on the source table because the twin's absence is
    // ambiguous: "never migrated" and "migrated, then deleted by the user in
    // Cowork" look identical to a NOT EXISTS probe.
    await run(`ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS migrated_to_cowork_at TIMESTAMPTZ`);

    const cols = CARRIED_COLUMNS.join(', ');
    const selectCols = CARRIED_COLUMNS.map(c => `t.${c}`).join(', ');

    // 1. Copy the schedules — but never a source row that has been migrated
    //    before, whatever became of its copy since.
    const inserted = await run(
        `INSERT INTO cowork_schedules (${cols})
         SELECT ${selectCols}
           FROM ai_tasks t
          WHERE ${where}
            AND t.migrated_to_cowork_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)`,
    );
    const migrated = inserted?.rowCount || 0;

    // 2. Seed one closed run per migrated task that ever ran, from the only
    //    execution record `ai_tasks` kept. The deterministic id doubles as the
    //    idempotency key — a second pass finds it and inserts nothing.
    const runsInserted = await run(
        `INSERT INTO cowork_runs
             (id, schedule_id, user_id, status, trigger_kind, started_at, finished_at, duration_ms, result, error)
         SELECT 'migrated-' || t.id,
                t.id,
                t.user_id,
                COALESCE(t.last_status, 'success'),
                'schedule',
                t.last_run_at,
                t.last_run_at,
                NULL,
                CASE WHEN t.last_status = 'success' THEN t.last_result END,
                CASE WHEN t.last_status IN ('error', 'needs_reauth') THEN t.last_result END
           FROM ai_tasks t
          WHERE ${where}
            AND t.last_run_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)
            AND NOT EXISTS (SELECT 1 FROM cowork_runs r WHERE r.id = 'migrated-' || t.id)`,
    );
    const runsSeeded = runsInserted?.rowCount || 0;

    // 3. Take the originals off the aiTaskRunner's tick. They are left in place
    //    rather than deleted: the copy is a few minutes old and this is the
    //    only way back if something about it turns out wrong. Nothing lists
    //    them any more (AITasksDesigner filters to agent-linked rows).
    const deactivated = await run(
        `UPDATE ai_tasks t
            SET is_active = FALSE
          WHERE ${where}
            AND t.is_active = TRUE
            AND EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)`,
    );

    // 4. Stamp every source row that has a cowork twin. Runs after the copy so
    //    a pre-stamp database (twins created by an earlier run of this
    //    migration, before the stamp existed) is caught up in one pass.
    await run(
        `UPDATE ai_tasks t
            SET migrated_to_cowork_at = NOW()
          WHERE ${where}
            AND t.migrated_to_cowork_at IS NULL
            AND EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.id)`,
    );

    const summary = {
        migrated,
        runsSeeded,
        deactivated: deactivated?.rowCount || 0,
    };
    if (summary.migrated > 0 || summary.deactivated > 0) {
        console.log(
            `[Migration] ${label} applied `
            + `(${summary.migrated} moved, ${summary.runsSeeded} history rows seeded, `
            + `${summary.deactivated} originals paused)`,
        );
    }
    return summary;
}

async function up() {
    return moveTasksToCowork({ where: PLAIN_TASK, label: 'prompt-tasks-to-cowork-2026-08' });
}

module.exports = { up, moveTasksToCowork, CARRIED_COLUMNS, PLAIN_TASK };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
