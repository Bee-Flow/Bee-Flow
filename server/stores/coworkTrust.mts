/**
 * Trust per action and recipient (core/cowork/planTrust.mts), on `cowork_trust`: per item, step and recipient, how
 * often the owner let it through since they last stopped it, and whether they let it go on its own. The decisions
 * of one journey are read from the engine's approvals of its questions (core/cowork/plan/planIndependence.mts).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = { getOne: (sql: string, params?: unknown[]) => Promise<Row | null>; getAll: (sql: string, params?: unknown[]) => Promise<Row[]>; run: (sql: string, params?: unknown[]) => Promise<unknown> };

export interface TrustRow { stepId: string; recipient: string; letThrough: number; trusted: boolean }
export interface Decision { stepId: string; status: string }

const toRow = (r: Row): TrustRow => ({ stepId: String(r.step_id), recipient: String(r.recipient), letThrough: Number(r.let_through ?? 0), trusted: r.trusted === true });

export function makeCoworkTrust({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** One decision of the owner: let through counts one up; a stop starts the count again and takes the trust away. */
    async function recordDecision(scheduleId: string, stepId: string, recipient: string, approved: boolean): Promise<void> {
        await ready();
        await db.run(
            `INSERT INTO cowork_trust (schedule_id, step_id, recipient, let_through, trusted) VALUES ($1, $2, $3, $4, FALSE)
             ON CONFLICT (schedule_id, step_id, recipient) DO UPDATE SET
                let_through = CASE WHEN $5 THEN cowork_trust.let_through + 1 ELSE 0 END,
                trusted = CASE WHEN $5 THEN cowork_trust.trusted ELSE FALSE END,
                updated_at = NOW()`,
            [scheduleId, stepId, recipient, approved ? 1 : 0, approved],
        );
    }

    async function listTrust(scheduleId: string): Promise<TrustRow[]> {
        await ready();
        return (await db.getAll('SELECT * FROM cowork_trust WHERE schedule_id = $1 ORDER BY step_id, recipient', [scheduleId])).map(toRow);
    }

    /** Let one step and recipient go on its own, or ask again. Answers whether there was such a row. */
    async function setTrusted(scheduleId: string, stepId: string, recipient: string, trusted: boolean): Promise<boolean> {
        await ready();
        const row = await db.getOne(
            'UPDATE cowork_trust SET trusted = $4, updated_at = NOW() WHERE schedule_id = $1 AND step_id = $2 AND recipient = $3 RETURNING step_id',
            [scheduleId, stepId, recipient, trusted],
        );
        return !!row;
    }

    /** The decisions on the questions of one journey (every leg of it), by question step. */
    async function decisionsOfJourney(journeyId: string, questionPrefix: string): Promise<Decision[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT a.step_id, a.status FROM automation_approvals a
              WHERE a.run_id IN (SELECT r.id FROM automation_runs r WHERE r.id = $1 OR r.root_run_id = $1)
                AND left(a.step_id, length($2)) = $2`,
            [journeyId, questionPrefix],
        );
        return rows.map((r) => ({ stepId: String(r.step_id), status: String(r.status) }));
    }

    return { recordDecision, listTrust, setTrusted, decisionsOfJourney };
}

let defaultTrust: ReturnType<typeof makeCoworkTrust> | null = null;

/** The store on the server's pool, after the Cowork schema is there. */
export function coworkTrust(): ReturnType<typeof makeCoworkTrust> {
    if (!defaultTrust) defaultTrust = makeCoworkTrust({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    return defaultTrust;
}
