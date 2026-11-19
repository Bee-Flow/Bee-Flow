/**
 * Closing one Cowork history row (next to stores/coworkStore.js, whose markCompleted / markError call this).
 *
 * The row closed is the one the run names (`runId`: an agent run and a follow-up know their own row), else the newest
 * open row of the schedule. Naming it matters as soon as two runs of one item overlap (a follow-up while a mail run
 * is busy): the newest open row is then another run's.
 *
 * Returns the run id, or null when there is nothing open — a manual run-now that raced the scheduler, or a server
 * restart mid-run. Callers treat null as "no history row to update" rather than as an error: losing a history row
 * must never fail the work.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = {
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    run: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const { deriveProducedOutput } = nodeRequire('./coworkRows.js') as { deriveProducedOutput: (result: unknown) => boolean };

/** What a run adds to its row when it closes (all optional). */
export type RunClose = {
    runId?: string | null;
    review?: { reason: string; question?: string | null; summary?: string | null } | null;
    activity?: unknown;
    conversationId?: string | null;
    runContext?: unknown;
    mailSubject?: string | null;
};

export type CloseOpts = RunClose & { status: string; result?: unknown; error?: unknown; producedOutput?: boolean };

const jsonOrNull = (v: unknown): string | null => (v && typeof v === 'object' ? JSON.stringify(v) : null);

export function makeRunClose({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    function openRunRow(scheduleId: string, runId: string | null | undefined): Promise<Row | null> {
        if (runId) {
            return db.getOne(
                'SELECT id, started_at FROM cowork_runs WHERE id = $1 AND schedule_id = $2 AND finished_at IS NULL',
                [runId, scheduleId],
            );
        }
        return db.getOne(
            `SELECT id, started_at FROM cowork_runs
             WHERE schedule_id = $1 AND finished_at IS NULL
             ORDER BY started_at DESC LIMIT 1`,
            [scheduleId],
        );
    }

    async function closeOpenRun(scheduleId: string, o: CloseOpts): Promise<string | null> {
        await ready();
        const openRun = await openRunRow(scheduleId, o.runId);
        if (!openRun) return null;
        // CW-13: the "was there anything to report" judgement falls HERE, once, and is
        // stored. An explicit value from the caller wins; otherwise deriveProducedOutput
        // infers it from what has been stored.
        const produced = typeof o.producedOutput === 'boolean' ? o.producedOutput : deriveProducedOutput(o.result);
        await db.run(
            `UPDATE cowork_runs
             SET status = $1,
                 result = $2,
                 error = $3,
                 produced_output = $4,
                 finished_at = NOW(),
                 duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
                 conversation_id = COALESCE($6, conversation_id),
                 activity_json = COALESCE($7, activity_json),
                 run_context_json = COALESCE($8, run_context_json),
                 mail_subject = COALESCE($9, mail_subject),
                 review_reason = $10,
                 review_question = $11,
                 review_summary = $12
             WHERE id = $5`,
            [o.status, o.result ?? null, o.error ?? null, produced, openRun.id,
                o.conversationId || null, jsonOrNull(o.activity), jsonOrNull(o.runContext), o.mailSubject || null,
                o.review?.reason || null, o.review?.question || null, o.review?.summary || null],
        );
        return openRun.id as string;
    }

    return { closeOpenRun };
}
