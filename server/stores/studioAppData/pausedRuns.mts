/**
 * stores/studioAppData/pausedRuns.mts: the queries of a run on hold, part of the action-run
 * store (./actionRuns.mts makes them with its database and row mapper). The runner is
 * appStudio/backgroundRun.mts with backgroundRunDurable.mts.
 *
 *   pauseRun          running → paused, with the walk state, the wake time and what it waits
 *                     for; refused once a cancel was asked
 *   countPaused       paused rows of an app, for the cap
 *   getRunById        one row by id alone (the wake job; the caller authorises through the row's app)
 *   pausedStateOf     the state of a paused row, read without taking it
 *   claimResume       paused → running as a compare-and-set on resume_seq: of two resumers
 *                     exactly one gets the state, and the state leaves the row with it
 *   resumeTokenHash   what a paused row's resume token must hash to
 *   listDueWakes      paused rows whose wake time passed
 *   findPausedByWait  paused rows waiting for (kind, ref)
 *   requestCancel     a paused row → cancelled at once; a running row gets the flag its job reads
 *   cancelRequested   the flag of one running row
 *   endPauses         paused rows that can never continue → interrupted (the retention pass); answers
 *                     what each ended row waited for, so the pass can withdraw an open request
 */

import type { ActionRunRow, Queryable } from './actionRuns.mts';

type QueryResult = Awaited<ReturnType<Queryable['query']>>;

export type PauseRun = {
    state: Record<string, unknown>; wakeAt: number | null; waitKind: string | null; waitRef: string | null; tokenHash: string | null;
    progress: Record<string, unknown>;
};

/** What a pause the retention pass ended was waiting for (kind and ref null for a timer). */
export type EndedWait = { runId: string; appId: string; waitKind: string | null; waitRef: string | null };

/** What the winner of a resume gets: the state the run paused with, and the row as it was. */
export type ClaimedResume = { row: ActionRunRow; state: Record<string, unknown>; tokenHash: string | null };

const changed = (r: QueryResult): number => r.rowCount ?? r.affectedRows ?? 0;
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): Record<string, unknown> | null => {
    let j: unknown = v ?? null;
    if (typeof v === 'string') { try { j = JSON.parse(v); } catch { j = null; } }
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null;
};

export function makePausedRunQueries(db: Queryable, ready: () => Promise<unknown>, toRun: (row: Record<string, unknown>) => ActionRunRow) {
    /** Paused rows that match `where` ($1 = the reason, $2 = the batch, $3.. = `params`) → interrupted, their state dropped. */
    async function endPauses(where: string, params: unknown[], reason: string, batch: number): Promise<EndedWait[]> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_action_runs
                SET status = 'interrupted', ended_at = NOW(), ended_by = 'expired', error = $1, error_code = 'pause_expired',
                    paused_state = NULL, wake_at = NULL, resume_token_hash = NULL
              WHERE id IN (SELECT id FROM studio_app_action_runs WHERE status = 'paused' AND ${where} LIMIT $2)
                AND status = 'paused'
          RETURNING id, app_id, wait_kind, wait_ref`,
            [reason, batch, ...params],
        );
        return rows.map((r) => ({ runId: String(r.id), appId: String(r.app_id), waitKind: text(r.wait_kind), waitRef: text(r.wait_ref) }));
    }

    /** running → paused. False when the row is no longer running, or a cancel was asked (the caller then ends it cancelled). */
    async function pauseRun(id: string, p: PauseRun): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs
                SET status = 'paused', paused_state = $2::jsonb, paused_at = NOW(), wake_at = to_timestamp($3::double precision / 1000),
                    wait_kind = $4, wait_ref = $5, resume_token_hash = $6, progress = $7::jsonb, instance_id = NULL, last_activity_at = NOW()
              WHERE id = $1 AND status = 'running' AND cancel_requested = FALSE`,
            [id, JSON.stringify(p.state), p.wakeAt, p.waitKind, p.waitRef, p.tokenHash, JSON.stringify(p.progress)],
        )) > 0;
    }

    async function countPaused(appId: string): Promise<number> {
        await ready();
        const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM studio_app_action_runs WHERE app_id = $1 AND status = 'paused'`, [appId]);
        return Number(rows[0]?.n ?? 0);
    }

    /** One row by its id alone. For the wake job and a server-side resume: the caller authorises through the row's own app. */
    async function getRunById(id: string): Promise<ActionRunRow | null> {
        await ready();
        const { rows } = await db.query('SELECT * FROM studio_app_action_runs WHERE id = $1', [id]);
        return rows[0] ? toRun(rows[0]) : null;
    }

    /**
     * paused → running, as a compare-and-set: only the caller whose `resumeSeq` is still the
     * row's gets it. The state and the token hash leave the row in the same statement, so a
     * token is used once and the state is not at rest while the run goes on.
     */
    async function claimResume(id: string, resumeSeq: number, instanceId: string | null): Promise<ClaimedResume | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_action_runs r
                SET status = 'running', resume_seq = r.resume_seq + 1, paused_state = NULL, wake_at = NULL, wait_kind = NULL, wait_ref = NULL,
                    resume_token_hash = NULL, instance_id = $3, last_activity_at = NOW()
               FROM (SELECT id, paused_state, resume_token_hash FROM studio_app_action_runs WHERE id = $1 AND status = 'paused' AND resume_seq = $2 FOR UPDATE) was
              WHERE r.id = was.id AND r.status = 'paused' AND r.resume_seq = $2
          RETURNING r.*, was.paused_state AS was_state, was.resume_token_hash AS was_token_hash`,
            [id, resumeSeq, instanceId],
        );
        const row = rows[0];
        const state = row ? asObj(row.was_state) : null;
        if (!row || !state) return null;
        return { row: toRun(row), state, tokenHash: text(row.was_token_hash) };
    }

    /** The sha256 a paused row's resume token must hash to (null: it has none). For the check before the claim. */
    async function resumeTokenHash(id: string): Promise<string | null> {
        await ready();
        const { rows } = await db.query(`SELECT resume_token_hash FROM studio_app_action_runs WHERE id = $1 AND status = 'paused'`, [id]);
        return text(rows[0]?.resume_token_hash);
    }

    /** The state of a paused row at this resume counter, read without taking it (the identity check before the claim). */
    async function pausedStateOf(id: string, resumeSeq: number): Promise<Record<string, unknown> | null> {
        await ready();
        const { rows } = await db.query(`SELECT paused_state FROM studio_app_action_runs WHERE id = $1 AND status = 'paused' AND resume_seq = $2`, [id, resumeSeq]);
        return asObj(rows[0]?.paused_state);
    }

    /** Paused rows whose wake time passed, oldest first. `limit` 0: all of them. */
    async function listDueWakes(limit: number): Promise<ActionRunRow[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_runs WHERE status = 'paused' AND wake_at IS NOT NULL AND wake_at <= NOW()
              ORDER BY wake_at ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
        );
        return rows.map(toRun);
    }

    /** Paused rows that wait for (kind, ref), at most 50. */
    async function findPausedByWait(waitKind: string, waitRef: string): Promise<ActionRunRow[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_runs WHERE status = 'paused' AND wait_kind = $1 AND wait_ref = $2 ORDER BY paused_at LIMIT 50`,
            [waitKind, waitRef],
        );
        return rows.map(toRun);
    }

    /**
     * Cancel a run of `appId`. One statement, so it cannot interleave with a resume: a paused
     * row ends `cancelled` there and then (its state and token go), a running row gets the flag
     * its job reads before its next step. Answers the row's status after it, or null when the
     * row is not of this app or already ended.
     */
    async function requestCancel(appId: string, id: string): Promise<'cancelled' | 'running' | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_action_runs
                SET cancel_requested = TRUE,
                    status = CASE WHEN status = 'paused' THEN 'cancelled' ELSE status END,
                    ended_at = CASE WHEN status = 'paused' THEN NOW() ELSE ended_at END,
                    ended_by = CASE WHEN status = 'paused' THEN 'user' ELSE ended_by END,
                    paused_state = NULL, wake_at = NULL, resume_token_hash = NULL
              WHERE app_id = $1 AND id = $2 AND origin IN ('background', 'trigger') AND status IN ('running', 'paused')
          RETURNING status`,
            [appId, id],
        );
        const status = rows[0]?.status;
        return status === 'cancelled' || status === 'running' ? status : null;
    }

    /** True when a cancel was asked for this running row. */
    async function cancelRequested(id: string): Promise<boolean> {
        await ready();
        const { rows } = await db.query(`SELECT cancel_requested FROM studio_app_action_runs WHERE id = $1 AND status = 'running'`, [id]);
        return rows[0]?.cancel_requested === true;
    }

    return { endPauses, pauseRun, countPaused, getRunById, claimResume, resumeTokenHash, pausedStateOf, listDueWakes, findPausedByWait, requestCancel, cancelRequested };
}
