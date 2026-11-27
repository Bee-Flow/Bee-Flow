// @typecheck strict
'use strict';

/**
 * The automation module's part of the operational metric rollups (stores/metricsStore.js asks
 * for it by name): the automation queue and the runs of the last day. Aggregate counts only,
 * platform-wide, no org or user dimension.
 */

/** @typedef {(sql: string, params?: unknown[]) => Promise<any[]>} GetAll */

/**
 * In-flight automation work by status: rows `{ status, value }`.
 * @param {GetAll} getAll
 */
function queueDepth(getAll) {
    return getAll(`
        SELECT status, COUNT(*)::int AS value
          FROM automation_runs
         WHERE status IN ('queued', 'running', 'awaiting_approval', 'awaiting_form')
         GROUP BY status`);
}

/**
 * Automation runs in the last 24h by outcome: rows `{ status, value, avg_duration_ms }`.
 * @param {GetAll} getAll
 */
function runsLastDay(getAll) {
    return getAll(`
        SELECT status, COUNT(*)::int AS value,
               COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int AS avg_duration_ms
          FROM automation_runs
         WHERE created_at > NOW() - INTERVAL '1 day'
         GROUP BY status`);
}

module.exports = { queueDepth, runsLastDay };
