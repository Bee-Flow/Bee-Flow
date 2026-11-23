/**
 * Claiming one attempt of a Cowork schedule, and giving a claim back (next to stores/coworkStore.js, which exports
 * both as `markRunning` and `releaseRun`).
 *
 * THE CLAIM. `markRunning` flips the schedule to 'running' and opens the history row of the attempt in ONE statement,
 * and only when no other attempt holds the schedule. It answers the row's id (the run a ledger row names as `run_id`),
 * or NULL when nothing was claimed, and then the caller must not run:
 *
 *   - the schedule is unknown;
 *   - another attempt holds it (`last_status = 'running'`). An unconditional flip would let two replicas that read
 *     the same due row on the same tick both run it, and let a run-now pressed during a scheduled run start a second
 *     run next to it;
 *   - `due` (the scheduler tick asks this) and the schedule is not due any more: paused meanwhile, or its moment was
 *     run and moved on by the replica that claimed first. Without it a slow replica that still holds its stale read
 *     claims again the moment the first run closes.
 *
 * The guarded UPDATE is the claim, the way automationStore.markRunning's is: of two callers, one gets a row back.
 *
 * GIVING BACK. An attempt that could not start for a reason that is nobody's failure (the feature service did not
 * answer) hands its claim back with `releaseRun`: the history row it opened is removed and the schedule is due again
 * on the next tick. A schedule left on 'running' is skipped by the due query until the reaper closes its row as a
 * failure, half an hour later.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

type Db = { run: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<{ id?: string }> } | null | undefined> };

export interface ClaimOpts {
    /** What started the attempt, as the history row records it: 'schedule', 'manual'. */
    triggerKind?: string;
    /** The scheduler tick started this for a due moment: the schedule must still be active and due. */
    due?: boolean;
}

export function makeCoworkClaims({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    async function markRunning(id: string, { triggerKind = 'schedule', due = false }: ClaimOpts = {}): Promise<string | null> {
        await ready();
        const res = await db.run(
            `WITH flipped AS (
                UPDATE cowork_schedules
                   SET last_status = 'running'
                 WHERE id = $2
                   AND last_status IS DISTINCT FROM 'running'
                   AND ($4::boolean IS NOT TRUE
                        OR (is_active = TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()))
                 RETURNING user_id)
             INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind)
             SELECT $1, $2, user_id, 'running', $3 FROM flipped RETURNING id`,
            [randomUUID(), id, triggerKind, due === true],
        );
        return res?.rows?.[0]?.id ?? null;
    }

    /** One statement: only a row that is still open goes, and only a schedule that still says 'running' is released. */
    async function releaseRun(scheduleId: string, runId: string | null | undefined): Promise<void> {
        if (!runId) return;
        await ready();
        await db.run(
            `WITH gone AS (
                DELETE FROM cowork_runs
                 WHERE id = $2 AND schedule_id = $1 AND finished_at IS NULL
                 RETURNING schedule_id)
             UPDATE cowork_schedules
                SET last_status = 'pending'
              WHERE id IN (SELECT schedule_id FROM gone) AND last_status = 'running'`,
            [scheduleId, runId],
        );
    }

    return { markRunning, releaseRun };
}
