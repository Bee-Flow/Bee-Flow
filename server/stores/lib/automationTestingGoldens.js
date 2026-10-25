// @typecheck noImplicitAny
/**
 * Golden runs: a finished run kept as the reference a later replay is compared
 * with. The row holds the run's id, a label and the paths the comparison
 * ignores. The last replay's outcome is kept as a verdict only
 * ({status, summary, errorCode}): never a value of either run.
 */

'use strict';

const { newId, toIso, fromJson } = require('./automationTestingCases');

/**
 * @typedef {{ id: string, automation_id: string, run_id: string, label?: string | null, ignore_paths?: unknown,
 *   created_by?: string | null, created_at?: Date | string | null, last_replay_json?: unknown,
 *   last_replay_run_id?: string | null, last_replay_at?: Date | string | null }} GoldenRow
 */

/** @param {GoldenRow} r */
function rowToGolden(r) {
    /** @type {{ status?: string, summary?: string, errorCode?: string } | null} */
    const replay = fromJson(r.last_replay_json, null);
    return {
        id: r.id,
        automationId: r.automation_id,
        runId: r.run_id,
        label: r.label ?? null,
        ignorePaths: fromJson(r.ignore_paths, []),
        createdBy: r.created_by ?? null,
        createdAt: toIso(r.created_at),
        lastReplay: replay ? {
            status: replay.status ?? null,
            summary: replay.summary ?? null,
            errorCode: replay.errorCode ?? null,
            replayRunId: r.last_replay_run_id ?? null,
            at: toIso(r.last_replay_at),
        } : null,
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {() => Promise<void>} ready
 */
function makeGoldens(db, ready) {
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     */
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /** @param {{ automationId: string, runId: string, label?: string | null, ignorePaths?: string[], createdBy?: string | null }} opts */
    async function createGolden({ automationId, runId, label, ignorePaths, createdBy }) {
        const { rows } = await q(
            `INSERT INTO automation_golden_runs (id, automation_id, run_id, label, ignore_paths, created_by)
             VALUES ($1, $2, $3, $4, $5::json, $6)
             ON CONFLICT (run_id) DO UPDATE SET label = EXCLUDED.label, ignore_paths = EXCLUDED.ignore_paths
             RETURNING *`,
            [newId('gold_'), automationId, runId, label ?? null, JSON.stringify(ignorePaths ?? []), createdBy ?? null],
        );
        return rowToGolden(rows[0]);
    }

    /** @param {string} automationId @param {string} goldenId */
    async function getGolden(automationId, goldenId) {
        const { rows } = await q('SELECT * FROM automation_golden_runs WHERE automation_id = $1 AND id = $2', [automationId, goldenId]);
        return rows[0] ? rowToGolden(rows[0]) : null;
    }

    /** @param {string} runId */
    async function getGoldenByRun(runId) {
        const { rows } = await q('SELECT * FROM automation_golden_runs WHERE run_id = $1', [runId]);
        return rows[0] ? rowToGolden(rows[0]) : null;
    }

    /** @param {string} automationId */
    async function listGoldens(automationId) {
        const { rows } = await q('SELECT * FROM automation_golden_runs WHERE automation_id = $1 ORDER BY created_at DESC, id', [automationId]);
        return rows.map(rowToGolden);
    }

    /** @param {string} automationId */
    async function countGoldens(automationId) {
        const { rows } = await q('SELECT COUNT(*)::int AS n FROM automation_golden_runs WHERE automation_id = $1', [automationId]);
        return Number(rows[0]?.n || 0);
    }

    /** @param {string} runId */
    async function deleteGoldenByRun(runId) {
        const { rows } = await q('DELETE FROM automation_golden_runs WHERE run_id = $1 RETURNING id', [runId]);
        return rows.length > 0;
    }

    /** Record a replay's verdict. Nothing but status, summary and errorCode is kept. */
    /** @param {string} goldenId @param {{ status: string, summary?: string | null, replayRunId?: string | null, errorCode?: string | null }} verdict */
    async function setGoldenReplay(goldenId, { status, summary = null, replayRunId = null, errorCode = null }) {
        await q(
            `UPDATE automation_golden_runs
                SET last_replay_json = $2::json, last_replay_run_id = $3, last_replay_at = NOW()
              WHERE id = $1`,
            [goldenId, JSON.stringify({ status, summary: summary ?? null, errorCode: errorCode ?? null }), replayRunId ?? null],
        );
    }

    return { createGolden, getGolden, getGoldenByRun, listGoldens, countGoldens, deleteGoldenByRun, setGoldenReplay };
}

module.exports = { makeGoldens, rowToGolden };
