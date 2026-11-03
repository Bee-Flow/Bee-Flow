/**
 * pauseRowStore.mts: the rows a person touches when they END a run's pause
 * outside the runner (routes/automation/runPauseOps.mts, automation/approvalService.js,
 * automation/approvalDecision.js):
 *
 *   closeAwaitingStepRow       the paused step row: 'cancelled' (withdrawn, form
 *                              wait closed) or 'rejected'; only a row still in
 *                              its paused status moves, so a row the runner
 *                              already settled is left alone
 *   getFormSessionsForJourney  the visitor sessions of a run's journey, with
 *                              is_test (a test link's) so the builder never
 *                              answers a real visitor's page
 *   endFormSessionForRun       the journey's session ends now: the visitor's
 *                              next poll answers "expired", queued work on it
 *                              is dropped (the sweep only claims sessions that
 *                              have not expired), the retention purge removes it
 *
 * "The journey" is every leg that shares the run's root: a session's run_id
 * follows the newest leg, so its session is the one whose run_id is ANY of them.
 *
 * Plain TypeScript that Node strips on load, importing nothing: the database
 * arrives as `db` (folderStore.mts does the same), and the pg test runs it on
 * PGlite.
 */

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

const JOURNEY_RUN_IDS = `SELECT l.id FROM automation_runs l
          WHERE COALESCE(l.root_run_id, l.id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)`;

const changed = (r: { rowCount?: number | null; affectedRows?: number }): number => r.rowCount ?? r.affectedRows ?? 0;

export function makePauseRowStore(db: Queryable, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    async function closeAwaitingStepRow(runId: string, stepId: string, fromStatus: string, toStatus: string): Promise<number> {
        if (!runId || !stepId) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE automation_run_steps SET status = $4, finished_at = COALESCE(finished_at, NOW())
              WHERE run_id = $1 AND step_id = $2 AND status = $3`,
            [runId, stepId, fromStatus, toStatus],
        ));
    }

    async function getFormSessionsForJourney(runId: string): Promise<{ id: string; isTest: boolean }[]> {
        if (!runId) return [];
        await ready();
        const { rows } = await db.query(
            `SELECT id, COALESCE(is_test, FALSE) AS is_test FROM automation_form_sessions
              WHERE run_id IN (${JOURNEY_RUN_IDS})`,
            [runId],
        );
        return rows.map((r) => ({ id: String(r.id), isTest: r.is_test === true }));
    }

    async function endFormSessionForRun(runId: string): Promise<number> {
        if (!runId) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE automation_form_sessions
                SET expires_at = NOW(), updated_at = NOW(),
                    pending_work = NULL, pending_lease_until = NULL, pending_attempts = 0
              WHERE run_id IN (${JOURNEY_RUN_IDS})`,
            [runId],
        ));
    }

    return { closeAwaitingStepRow, getFormSessionsForJourney, endFormSessionForRun };
}
