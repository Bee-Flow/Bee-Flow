// @typecheck strict
/**
 * runDurations.js — how long the recent legs of an automation took.
 *
 * A leg is one run row: a journey that pauses for a form page or an approval
 * is a chain of legs, each resume a child run. `duration_ms` is written for a
 * finished leg and for one that paused on a form, so those two statuses carry
 * the "how long does the automation work between questions" figure the public
 * form poll turns into a typical-duration hint.
 */

const { initDB, getAll } = require('./core');

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

/**
 * Durations (ms) of the newest live, non-test legs of an automation that
 * finished or paused on a form. Newest first. Uses idx_automation_runs_aid_started.
 *
 * @param {string} automationId
 * @param {{ limit?: number, query?: typeof getAll | null }} [opts]  `query` is an injected reader (tests)
 * @returns {Promise<number[]>}
 */
async function recentLegDurations(automationId, { limit = LIMIT_DEFAULT, query = null } = {}) {
    if (!automationId) return [];
    const n = Math.min(LIMIT_MAX, Math.max(1, Math.trunc(Number(limit)) || LIMIT_DEFAULT));
    const read = query || getAll;
    if (!query) await initDB();
    const rows = await read(
        `SELECT duration_ms FROM automation_runs
          WHERE automation_id = $1 AND mode = 'live' AND COALESCE(is_test, false) = false
            AND status IN ('success', 'awaiting_form')
            AND duration_ms IS NOT NULL AND duration_ms > 0
          ORDER BY started_at DESC NULLS LAST
          LIMIT $2`,
        [automationId, n],
    );
    return rows.map((r) => Number(r.duration_ms)).filter((v) => Number.isFinite(v) && v > 0);
}

module.exports = { recentLegDurations };
