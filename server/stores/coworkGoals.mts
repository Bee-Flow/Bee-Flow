/**
 * The goals of Cowork items (core/cowork/goals, usecases/coworkGoals.mts): one goal per item, `cowork_goals`, with the
 * sentence its owner wrote, the share of the work that should meet it, and the CHECK that measures it: the automation
 * the check was drafted as, and the definition and fingerprint its owner approved. `cowork_goal_results` holds one
 * measurement per cowork run that was measured: two numbers (`met` of `total`), or why the check could not tell.
 *
 * A measurement is claimed per item (`claimMeasurement`): the claim only moves forward when the last one is older than
 * the window, so two runs that end close together, on one server or two, measure once.
 *
 * Both tables go with their item (ON DELETE CASCADE): a goal is part of the item it is about.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
    tx<T>(fn: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> }) => Promise<T>): Promise<T>;
}

export const COWORK_GOALS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_goals (
        schedule_id TEXT PRIMARY KEY REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        sentence TEXT NOT NULL,
        target_percent INTEGER NOT NULL DEFAULT 100,
        check_automation_id TEXT,
        approved_definition_json TEXT,
        fingerprint TEXT,
        approved_at TIMESTAMPTZ,
        measure_claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cowork_goals_user ON cowork_goals (user_id)',
    `CREATE TABLE IF NOT EXISTS cowork_goal_results (
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        met INTEGER,
        total INTEGER,
        period TEXT,
        ok BOOLEAN NOT NULL,
        error TEXT,
        measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cowork_goal_results_item ON cowork_goal_results (schedule_id, measured_at DESC)',
]);

export interface Goal {
    scheduleId: string;
    userId: string;
    sentence: string;
    targetPercent: number;
    checkAutomationId: string | null;
    /** The check as its owner approved it; null until then, and again after the sentence or the check changed. */
    approvedDefinition: unknown;
    fingerprint: string | null;
    approvedAt: string | null;
    createdAt: string | null;
}

export interface GoalResult {
    runId: string;
    met: number | null;
    total: number | null;
    /** What the numbers are about, as the check says it ("this week"); null when it says nothing. */
    period: string | null;
    ok: boolean;
    error: string | null;
    measuredAt: string | null;
}

export interface NewResult { runId: string; met: number | null; total: number | null; period: string | null; ok: boolean; error: string | null; measuredAt: Date }

/** An owner's goal with its latest good measurement (the home and the daily mail). */
export interface GoalCount { scheduleId: string; title: string; sentence: string; targetPercent: number; met: number | null; total: number | null; period: string | null; measuredAt: string | null }

/** The longest reason a failed measurement keeps. */
export const ERROR_MAX = 300;
const PERIOD_MAX = 60;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function parsed(v: unknown): unknown {
    if (typeof v !== 'string' || !v) return null;
    try { return JSON.parse(v); } catch { return null; }
}

function goalOf(r: Row): Goal {
    return {
        scheduleId: String(r.schedule_id), userId: String(r.user_id), sentence: String(r.sentence ?? ''),
        targetPercent: Number(r.target_percent ?? 100), checkAutomationId: text(r.check_automation_id),
        approvedDefinition: parsed(r.approved_definition_json), fingerprint: text(r.fingerprint),
        approvedAt: iso(r.approved_at), createdAt: iso(r.created_at),
    };
}

function resultOf(r: Row): GoalResult {
    return {
        runId: String(r.run_id), met: intOrNull(r.met), total: intOrNull(r.total), period: text(r.period),
        ok: r.ok === true, error: text(r.error), measuredAt: iso(r.measured_at),
    };
}

const UNAPPROVED = 'approved_definition_json = NULL, fingerprint = NULL, approved_at = NULL';

export function makeCoworkGoals(db: Queryable, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    const one = async (sql: string, params: unknown[]): Promise<Row | null> => { await ready(); return (await db.query(sql, params)).rows[0] ?? null; };

    /** The item's goal, or null. */
    async function getGoal(scheduleId: string): Promise<Goal | null> {
        const r = await one('SELECT * FROM cowork_goals WHERE schedule_id = $1', [scheduleId]);
        return r ? goalOf(r) : null;
    }

    /** Write the sentence and the target. A new sentence takes the check off: it was drafted and approved for the old one. */
    async function saveGoal(input: { scheduleId: string; userId: string; sentence: string; targetPercent: number }): Promise<Goal> {
        const r = await one(
            `INSERT INTO cowork_goals (schedule_id, user_id, sentence, target_percent) VALUES ($1, $2, $3, $4)
             ON CONFLICT (schedule_id) DO UPDATE SET
                 user_id = EXCLUDED.user_id, target_percent = EXCLUDED.target_percent, sentence = EXCLUDED.sentence,
                 check_automation_id = CASE WHEN cowork_goals.sentence = EXCLUDED.sentence THEN cowork_goals.check_automation_id END,
                 approved_definition_json = CASE WHEN cowork_goals.sentence = EXCLUDED.sentence THEN cowork_goals.approved_definition_json END,
                 fingerprint = CASE WHEN cowork_goals.sentence = EXCLUDED.sentence THEN cowork_goals.fingerprint END,
                 approved_at = CASE WHEN cowork_goals.sentence = EXCLUDED.sentence THEN cowork_goals.approved_at END
             RETURNING *`,
            [input.scheduleId, input.userId, input.sentence, input.targetPercent],
        );
        return goalOf(r as Row);
    }

    /** Name the automation the check was drafted as; what was approved before is no longer approved. */
    async function setCheck(scheduleId: string, automationId: string): Promise<boolean> {
        return !!(await one(`UPDATE cowork_goals SET check_automation_id = $2, ${UNAPPROVED} WHERE schedule_id = $1 RETURNING schedule_id`, [scheduleId, automationId]));
    }

    /** Keep the check as its owner approved it: the definition a measurement runs, and its fingerprint. */
    async function approveCheck(scheduleId: string, approval: { definition: unknown; fingerprint: string }): Promise<boolean> {
        return !!(await one(
            'UPDATE cowork_goals SET approved_definition_json = $2, fingerprint = $3, approved_at = NOW() WHERE schedule_id = $1 RETURNING schedule_id',
            [scheduleId, JSON.stringify(approval.definition), approval.fingerprint],
        ));
    }

    /** Take the goal off, with what it measured. */
    async function removeGoal(scheduleId: string): Promise<void> {
        await ready();
        await db.tx(async (client) => {
            await client.query('DELETE FROM cowork_goal_results WHERE schedule_id = $1', [scheduleId]);
            await client.query('DELETE FROM cowork_goals WHERE schedule_id = $1', [scheduleId]);
        });
    }

    /** Claim the item's next measurement at `now`; false while the last claim is younger than `windowMs`, or no check is approved. */
    async function claimMeasurement(scheduleId: string, now: Date, windowMs: number): Promise<boolean> {
        return !!(await one(
            `UPDATE cowork_goals SET measure_claimed_at = $2
             WHERE schedule_id = $1 AND approved_definition_json IS NOT NULL
               AND (measure_claimed_at IS NULL OR measure_claimed_at <= $3)
             RETURNING schedule_id`,
            [scheduleId, now.toISOString(), new Date(now.getTime() - windowMs).toISOString()],
        ));
    }

    /** Keep one measurement; the same run is measured once. */
    async function recordResult(scheduleId: string, result: NewResult): Promise<void> {
        await one(
            `INSERT INTO cowork_goal_results (schedule_id, run_id, met, total, period, ok, error, measured_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
            [scheduleId, result.runId, result.met, result.total, result.period?.slice(0, PERIOD_MAX) ?? null, result.ok, result.error?.slice(0, ERROR_MAX) ?? null, result.measuredAt.toISOString()],
        );
    }

    /** The item's measurements, newest first. */
    async function listResults(scheduleId: string, limit = 12): Promise<GoalResult[]> {
        await ready();
        const { rows } = await db.query('SELECT * FROM cowork_goal_results WHERE schedule_id = $1 ORDER BY measured_at DESC, run_id DESC LIMIT $2', [scheduleId, limit]);
        return rows.map(resultOf);
    }

    /** Every goal of the owner with its latest good measurement. */
    async function countsOfOwner(userId: string): Promise<GoalCount[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT g.schedule_id, s.title, g.sentence, g.target_percent, r.met, r.total, r.period, r.measured_at
               FROM cowork_goals g
               JOIN cowork_schedules s ON s.id = g.schedule_id
               LEFT JOIN LATERAL (
                   SELECT met, total, period, measured_at FROM cowork_goal_results x
                    WHERE x.schedule_id = g.schedule_id AND x.ok ORDER BY x.measured_at DESC LIMIT 1
               ) r ON TRUE
              WHERE g.user_id = $1 ORDER BY g.created_at, g.schedule_id`,
            [userId],
        );
        return rows.map((r) => ({
            scheduleId: String(r.schedule_id), title: String(r.title ?? ''), sentence: String(r.sentence ?? ''), targetPercent: Number(r.target_percent ?? 100),
            met: intOrNull(r.met), total: intOrNull(r.total), period: text(r.period), measuredAt: iso(r.measured_at),
        }));
    }

    return { getGoal, saveGoal, setCheck, approveCheck, removeGoal, claimMeasurement, recordResult, listResults, countsOfOwner };
}

export type CoworkGoalsStore = ReturnType<typeof makeCoworkGoals>;

type RealDb = { pool: { query: Queryable['query'] }; exec: (sql: string) => Promise<unknown>; withTransaction: Queryable['tx'] };
type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };
const realDb = (): RealDb => nodeRequire('../db.js') as RealDb;

/** The schema init (ledgered, memoised), after the Cowork schema it refers to; storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkGoalsStore', async () => {
    await (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB();
    for (const sql of COWORK_GOALS_DDL) await realDb().exec(sql);
});

let defaultStore: CoworkGoalsStore | null = null;

/** The store on the server's pool. */
export function coworkGoals(): CoworkGoalsStore {
    if (!defaultStore) {
        defaultStore = makeCoworkGoals({
            query: (sql, params) => realDb().pool.query(sql, params),
            tx: (fn) => realDb().withTransaction(fn),
        }, { ready: initDB });
    }
    return defaultStore;
}
