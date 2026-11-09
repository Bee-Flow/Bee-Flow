// @typecheck strict
/**
 * runReaper.js — the stuck-run reaper of the automationStore aggregate
 * (re-exported by ./automations.js).
 */

'use strict';

const { initDB, pool } = require('./core');

/**
 * §WS3.3 — Reap orphaned run rows. A run whose worker pod crashed stays in
 * status='running' forever (the stuck-automations reaper only touches the
 * automations row, not automation_runs), leaking into the active-runs UI /
 * concurrency guard. This finally READS last_heartbeat_at (previously a dead
 * column): a healthy long run heartbeats every 15s so it's never stale; a dead
 * run stops heartbeating and is flipped to error after the window. Falls back to
 * started_at for runs that died before their first heartbeat. Returns reaped runs
 * so the caller can emit run.failed lifecycle events.
 * @param {{ staleAfterMs?: number, queuedStaleAfterMs?: number | null }} [opts]
 */
async function reapStuckRuns({ staleAfterMs = 6 * 60_000, queuedStaleAfterMs = null } = {}) {
    await initDB();
    const queuedWindowMs = queuedStaleAfterMs ?? staleAfterMs + 5 * 60_000;
    // A row that never left 'queued' is orphaned the same way: it is created
    // queued and only becomes running once the run holds the automation's
    // marker, which a webhook or event run may wait minutes for. A worker
    // that dies in that stretch left it queued for good — listed as active,
    // skipped by retention, and blocking reapStuckAutomations' repair clause.
    // It has no heartbeat, so its window is its own: the longest legitimate
    // wait for the marker plus the stale window (the caller passes it).
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = COALESCE(error_class, 'RunnerDied'),
                error = COALESCE(error, 'Run stopped heartbeating — the worker crashed or was killed.'),
                summary = COALESCE(summary, 'Run interrupted — the worker stopped responding.'),
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int)
          WHERE (status = 'running'
                 AND COALESCE(last_heartbeat_at, started_at) IS NOT NULL
                 AND COALESCE(last_heartbeat_at, started_at) < NOW() - ($1::int * INTERVAL '1 millisecond'))
             OR (status = 'queued'
                 AND started_at IS NOT NULL
                 AND started_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
          RETURNING id, automation_id, user_id`,
        [staleAfterMs, queuedWindowMs],
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

module.exports = { reapStuckRuns };
