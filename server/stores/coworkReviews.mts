/**
 * The review queue of Cowork, on `cowork_runs` (next to stores/coworkStore.js, which re-exports these):
 *
 *   - a run waits for review while its status is 'needs_review' and nobody handled it (review_resolved_at NULL);
 *   - handling one is ONCE: the UPDATE only matches a waiting run, so a double click or two tabs resolve it once;
 *   - an answer opens the follow-up run in the same transaction: a 'running' row with trigger_kind 'review', the run
 *     it continues as its parent, one answer deeper, in the same conversation and with the same run context (the
 *     tools it was offered, a mail run's ids), and the schedule flips to 'running' with it.
 *
 * Who may handle a run is the route's question (the item's owner, routes/cowork.js loadOwned); every statement here
 * is also keyed on the schedule, so a run of another item never matches.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};

type Rows = typeof import('./coworkRows.js');
const { rowToRun: rowToRunTyped, safeParseJSON } = nodeRequire('./coworkRows.js') as Rows;
/** One history row in the API's shape (stores/coworkRows.js). */
export type CoworkRun = NonNullable<ReturnType<Rows['rowToRun']>>;
const rowToRun = (r: Row | null | undefined): CoworkRun | null => rowToRunTyped((r ?? null) as Parameters<Rows['rowToRun']>[0]);

/** How the owner handled a run that asked for review. */
export const REVIEW_RESOLUTIONS: ReadonlySet<string> = new Set(['answered', 'done_myself', 'not_needed']);

export function makeCoworkReviews({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** `{ scheduleId: number of runs waiting for review }`, for every item of one user; only items that have some. */
    async function getOpenReviewCounts(userId: string): Promise<Record<string, number>> {
        await ready();
        const rows = await db.getAll(
            `SELECT schedule_id, COUNT(*)::int AS n FROM cowork_runs
              WHERE user_id = $1 AND status = 'needs_review' AND review_resolved_at IS NULL
              GROUP BY schedule_id`,
            [userId],
        );
        const out: Record<string, number> = {};
        for (const r of rows) if (typeof r.schedule_id === 'string') out[r.schedule_id] = Number(r.n) || 0;
        return out;
    }

    async function countOpenReviews(scheduleId: string): Promise<number> {
        await ready();
        const r = await db.getOne(
            `SELECT COUNT(*)::int AS n FROM cowork_runs
              WHERE schedule_id = $1 AND status = 'needs_review' AND review_resolved_at IS NULL`,
            [scheduleId],
        );
        return Number(r?.n) || 0;
    }

    /** One run of one item with the server-side run context a follow-up needs; null when it is not that item's. */
    async function getRunForReview(scheduleId: string, runId: string): Promise<(CoworkRun & { runContext: unknown }) | null> {
        await ready();
        const row = await db.getOne('SELECT * FROM cowork_runs WHERE id = $1 AND schedule_id = $2', [runId, scheduleId]);
        if (!row) return null;
        const run = rowToRun(row);
        if (!run) return null;
        return { ...run, runContext: row.run_context_json ? safeParseJSON<unknown>(row.run_context_json as string, null) : null };
    }

    /**
     * Handle a waiting run, once. With `followUp` the follow-up row opens in the same transaction. Null when the run
     * is not (or no longer) waiting for review on this item.
     */
    async function resolveReview({ scheduleId, runId, userId, resolution, followUp }: {
        scheduleId: string; runId: string; userId: string; resolution: string; followUp: boolean;
    }): Promise<{ run: CoworkRun | null; followUpRunId: string | null } | null> {
        if (!REVIEW_RESOLUTIONS.has(resolution)) throw new Error(`Unknown review resolution: ${resolution}`);
        await ready();
        return db.withTransaction(async (client) => {
            const { rows } = await client.query(
                `UPDATE cowork_runs
                    SET review_resolution = $3, review_resolved_by = $4, review_resolved_at = NOW()
                  WHERE id = $1 AND schedule_id = $2 AND status = 'needs_review' AND review_resolved_at IS NULL
                  RETURNING *`,
                [runId, scheduleId, resolution, userId],
            );
            const resolved = rows[0];
            if (!resolved) return null;
            if (!followUp) return { run: rowToRun(resolved), followUpRunId: null };
            const followUpRunId = crypto.randomUUID();
            await client.query(
                `INSERT INTO cowork_runs
                    (id, schedule_id, user_id, status, trigger_kind, parent_run_id, followup_depth, conversation_id, run_context_json, mail_subject)
                 VALUES ($1, $2, $3, 'running', 'review', $4, $5, $6, $7, $8)`,
                [followUpRunId, scheduleId, resolved.user_id, runId, (Number(resolved.followup_depth) || 0) + 1,
                    resolved.conversation_id ?? null, resolved.run_context_json ?? null, resolved.mail_subject ?? null],
            );
            await client.query(`UPDATE cowork_schedules SET last_status = 'running' WHERE id = $1`, [scheduleId]);
            return { run: rowToRun(resolved), followUpRunId };
        });
    }

    return { getOpenReviewCounts, countOpenReviews, getRunForReview, resolveReview, ...makeCoworkOwnerRuns({ db, ready }) };
}

/** The owner's runs across their items: those that wait for them, and those of one day (Cowork's home). */
function makeCoworkOwnerRuns({ db, ready }: { db: Db; ready: () => Promise<unknown> }) {
    /**
     * The runs of one owner that wait for them (the Needs you queue, usecases/coworkNeedsYou.mts): a review nobody
     * handled yet, and a plan run waiting for a decision. Newest first, at most `limit`.
     */
    async function listRunsWaitingForOwner(userId: string, limit = 50): Promise<Array<{ runId: string; itemId: string; title: string; status: string; since: string | null; reason: string | null }>> {
        await ready();
        const rows = await db.getAll(
            `SELECT r.id, r.schedule_id, s.title, r.status, r.started_at, r.review_reason
               FROM cowork_runs r JOIN cowork_schedules s ON s.id = r.schedule_id
              WHERE s.user_id = $1
                AND ((r.status = 'needs_review' AND r.review_resolved_at IS NULL) OR r.status = 'waiting')
              ORDER BY r.started_at DESC LIMIT $2`,
            [userId, Math.max(1, Math.min(200, Math.floor(limit) || 1))],
        );
        return rows.map((r) => ({
            runId: String(r.id), itemId: String(r.schedule_id), title: String(r.title ?? ''), status: String(r.status),
            since: r.started_at ? new Date(r.started_at as string).toISOString() : null,
            reason: typeof r.review_reason === 'string' ? r.review_reason : null,
        }));
    }

    /** The owner's runs that started in [from, to), newest first, with the item's title: the "today" of Cowork's home. */
    async function listRunsBetween(userId: string, from: string, to: string, limit = 100): Promise<Array<{ runId: string; itemId: string; title: string; status: string; at: string | null }>> {
        await ready();
        const rows = await db.getAll(
            `SELECT r.id, r.schedule_id, s.title, r.status, r.started_at
               FROM cowork_runs r JOIN cowork_schedules s ON s.id = r.schedule_id
              WHERE s.user_id = $1 AND r.started_at >= $2 AND r.started_at < $3
              ORDER BY r.started_at DESC LIMIT $4`,
            [userId, from, to, Math.max(1, Math.min(200, Math.floor(limit) || 1))],
        );
        return rows.map((r) => ({
            runId: String(r.id), itemId: String(r.schedule_id), title: String(r.title ?? ''), status: String(r.status),
            at: r.started_at ? new Date(r.started_at as string).toISOString() : null,
        }));
    }

    return { listRunsWaitingForOwner, listRunsBetween };
}
