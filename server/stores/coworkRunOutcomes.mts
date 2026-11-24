/**
 * How Cowork runs really ended, read back (core/cowork/runOutcome.mts decides it, stores/coworkRunClose.mts writes it
 * as `cowork_runs.outcome_json`): for "Needs you" (usecases/coworkNeedsYou.mts) and for the automatic fix of a
 * reference (core/cowork/repairs/autoResolve.mts).
 *
 * Codes, ids and the plan's own references only: never a result, an error text or anything a run read.
 */

import { createRequire } from 'node:module';
import type { CoworkDb as Db, Row } from './lib/coworkDb.mts';

const nodeRequire = createRequire(import.meta.url);

/** An item whose last finished run did not do its work: incomplete, or failed by its own AI's verdict. */
export interface RunProblem { itemId: string; runId: string; kind: 'incomplete' | 'ai_failed'; since: string | null }

/** One run of an item, as the automatic fix reads it. */
export interface JudgedRun {
    runId: string;
    status: string;
    planId: string | null;
    automationRunId: string | null;
    startedAt: string | null;
    outcome: { kind?: string; [key: string]: unknown } | null;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
function parsed(v: unknown): { kind?: string; [key: string]: unknown } | null {
    if (typeof v !== 'string' || !v) return null;
    try {
        const out = JSON.parse(v) as unknown;
        return out && typeof out === 'object' && !Array.isArray(out) ? out as { kind?: string } : null;
    } catch { return null; }
}

/** The newest finished run per item of one owner, those of them that did not do their work. */
const PROBLEMS_SQL = `
    SELECT DISTINCT ON (r.schedule_id) r.schedule_id, r.id, r.status, r.outcome_json, r.finished_at
      FROM cowork_runs r JOIN cowork_schedules s ON s.id = r.schedule_id
     WHERE s.user_id = $1 AND r.finished_at IS NOT NULL AND r.status <> 'waiting'
     ORDER BY r.schedule_id, r.started_at DESC, r.id DESC`;

export function makeCoworkRunOutcomes({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    async function lastRunProblems(userId: string): Promise<RunProblem[]> {
        await ready();
        const rows = await db.getAll(PROBLEMS_SQL, [userId]);
        const out: RunProblem[] = [];
        for (const r of rows as Row[]) {
            const kind = parsed(r.outcome_json)?.kind;
            const problem = r.status === 'incomplete' ? 'incomplete' : r.status === 'error' && kind === 'ai_failed' ? 'ai_failed' : null;
            if (problem) out.push({ itemId: String(r.schedule_id), runId: String(r.id), kind: problem, since: iso(r.finished_at) });
        }
        return out;
    }

    async function judgedRun(scheduleId: string, runId: string): Promise<JudgedRun | null> {
        await ready();
        const r = await db.getOne(
            'SELECT id, status, plan_id, automation_run_id, started_at, outcome_json FROM cowork_runs WHERE id = $1 AND schedule_id = $2 AND finished_at IS NOT NULL',
            [runId, scheduleId],
        );
        if (!r) return null;
        return {
            runId: String(r.id), status: String(r.status ?? ''), planId: r.plan_id ? String(r.plan_id) : null,
            automationRunId: r.automation_run_id ? String(r.automation_run_id) : null, startedAt: iso(r.started_at), outcome: parsed(r.outcome_json),
        };
    }

    return { lastRunProblems, judgedRun };
}

export type CoworkRunOutcomes = ReturnType<typeof makeCoworkRunOutcomes>;

let defaultStore: CoworkRunOutcomes | null = null;

/** The store on the server's pool, after the Cowork schema. */
export function coworkRunOutcomes(): CoworkRunOutcomes {
    if (!defaultStore) {
        defaultStore = makeCoworkRunOutcomes({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    }
    return defaultStore;
}
