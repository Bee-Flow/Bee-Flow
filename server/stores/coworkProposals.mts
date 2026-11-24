/**
 * The proposals of Cowork (usecases/coworkProposals.mts): a repair it worked out after a plan kept failing, or an offer
 * to make a steady AI step a fixed one. One row per proposal, `cowork_proposals`, with the definition it proposes, the
 * fingerprint of the approved plan it was made on (`base_fingerprint`), what it may newly do (`widens_json`, the
 * sentences of core/cowork/plan/planPermissions.mts) and the replay that tested it. A proposal is NOT a change: nothing
 * here writes the item, its plan automation or its approved plans.
 *
 * At most one open proposal per item and kind (a partial unique index), so two triggers at once give one proposal.
 * `cowork_proposal_attempts` holds when an item was last tried per kind, claimed forward only once the window has
 * passed, so two servers attempt once. Read for the triggers: the failed step ids and error CLASSES of an item's last
 * runs (never an error message) and how often each step of an approved plan ended well.
 *
 * Both tables go with their item (ON DELETE CASCADE) and the proposals with the account of their owner
 * (stores/user/erasureCoverage.js). An item keeps its last KEEP decided proposals.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

import type { Row, Client, CoworkDb as Db } from './lib/coworkDb.mts';

export const COWORK_PROPOSALS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_proposals (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('repair', 'fixed_step')),
        reason_code TEXT NOT NULL,
        step_id TEXT,
        step_title TEXT,
        base_fingerprint TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        widens_json TEXT NOT NULL DEFAULT '[]',
        replay_id TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'dismissed', 'stale')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cowork_proposals_schedule ON cowork_proposals (schedule_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_cowork_proposals_user ON cowork_proposals (user_id)',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_proposals_one_open ON cowork_proposals (schedule_id, kind) WHERE status = 'open'`,
    `CREATE TABLE IF NOT EXISTS cowork_proposal_attempts (
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (schedule_id, kind)
    )`,
]);

export type ProposalKind = 'repair' | 'fixed_step';
/** What an attempt is claimed for: a proposal of a kind, or Cowork's own fix of a reference (core/cowork/repairs/autoResolve.mts). */
export type AttemptKind = ProposalKind | 'auto_fix';
export type ProposalStatus = 'open' | 'approved' | 'dismissed' | 'stale';
/** Decided proposals kept per item. */
export const KEEP = 20;
/** The longest step title kept. */
const TITLE_MAX = 200;

export interface Proposal {
    id: string;
    scheduleId: string;
    userId: string;
    kind: ProposalKind;
    reasonCode: string;
    stepId: string | null;
    stepTitle: string | null;
    baseFingerprint: string;
    definition: unknown;
    fingerprint: string;
    widens: string[];
    replayId: string | null;
    status: ProposalStatus;
    createdAt: string | null;
    decidedAt: string | null;
}

export type NewProposal = Omit<Proposal, 'status' | 'createdAt' | 'decidedAt'>;

/** An approved version of an item's plan. */
export interface PlanVersion { version: number; definition: unknown; fingerprint: string }

/** One of an item's last runs: the plan it followed, and the steps that failed with their error class. */
export interface RunFailures { runId: string; planId: string | null; failed: Array<{ stepId: string; errorClass: string | null }> }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function parsed(v: unknown): unknown {
    if (typeof v !== 'string') return v ?? null;
    try { return JSON.parse(v); } catch { return null; }
}
const sentences = (v: unknown): string[] => {
    const list = parsed(v);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
};

function proposalOf(r: Row): Proposal {
    return {
        id: String(r.id), scheduleId: String(r.schedule_id), userId: String(r.user_id),
        kind: r.kind === 'fixed_step' ? 'fixed_step' : 'repair', reasonCode: String(r.reason_code),
        stepId: text(r.step_id), stepTitle: text(r.step_title), baseFingerprint: String(r.base_fingerprint),
        definition: parsed(r.definition_json), fingerprint: String(r.fingerprint), widens: sentences(r.widens_json),
        replayId: text(r.replay_id), status: String(r.status) as ProposalStatus, createdAt: iso(r.created_at), decidedAt: iso(r.decided_at),
    };
}

/** The error class of a step whose own AI verdict was "failed". */
export const AI_FAILED_CLASS = 'ai_verdict_failed';

/** The last `n` finished runs of an item, newest first, with the steps that failed in them (step id and class only). */
const LAST_RUN_FAILURES_SQL = `
    WITH last AS (
        SELECT id, plan_id, automation_run_id, started_at, outcome_json FROM cowork_runs
         WHERE schedule_id = $1 AND finished_at IS NOT NULL AND status <> 'waiting'
         ORDER BY started_at DESC, id DESC LIMIT $2)
    SELECT last.id AS run_id, last.plan_id, last.started_at, last.outcome_json, s.step_id, s.error_class
      FROM last
      LEFT JOIN automation_runs a ON last.automation_run_id IS NOT NULL
           AND (a.id = last.automation_run_id OR a.root_run_id = last.automation_run_id)
      LEFT JOIN automation_run_steps s ON s.run_id = a.id AND s.status = 'error' AND s.parent_step_id IS NULL
     ORDER BY last.started_at DESC, last.id DESC, s.step_id`;

export function makeCoworkProposals({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Keep a new open proposal; answers null, and writes nothing, while the item has an open one of this kind. */
    async function createProposal(input: NewProposal): Promise<Proposal | null> {
        await ready();
        return db.withTransaction(async (client) => {
            const { rows } = await client.query(
                `INSERT INTO cowork_proposals (id, schedule_id, user_id, kind, reason_code, step_id, step_title, base_fingerprint, definition_json, fingerprint, widens_json, replay_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING RETURNING *`,
                [input.id, input.scheduleId, input.userId, input.kind, input.reasonCode, input.stepId, input.stepTitle?.slice(0, TITLE_MAX) ?? null,
                    input.baseFingerprint, JSON.stringify(input.definition), input.fingerprint, JSON.stringify(input.widens), input.replayId],
            );
            if (rows.length === 0) return null;
            await client.query(
                `DELETE FROM cowork_proposals WHERE schedule_id = $1 AND status <> 'open' AND id NOT IN (
                    SELECT id FROM cowork_proposals WHERE schedule_id = $1 AND status <> 'open' ORDER BY created_at DESC, id DESC LIMIT $2)`,
                [input.scheduleId, KEEP],
            );
            return proposalOf(rows[0] as Row);
        });
    }

    /**
     * Keep the record of a fix Cowork applied by itself (core/cowork/repairs/autoResolve.mts): a repair that is approved
     * as it is written, never open, so the item can show it with its Undo. Answers it, or null when nothing was written.
     */
    async function recordAutoFix(input: NewProposal): Promise<Proposal | null> {
        await ready();
        const row = await db.getOne(
            `INSERT INTO cowork_proposals (id, schedule_id, user_id, kind, reason_code, step_id, step_title, base_fingerprint, definition_json, fingerprint, widens_json, replay_id, status, decided_at)
             VALUES ($1, $2, $3, 'repair', $4, $5, $6, $7, $8, $9, '[]', $10, 'approved', NOW()) RETURNING *`,
            [input.id, input.scheduleId, input.userId, input.reasonCode, input.stepId, input.stepTitle?.slice(0, TITLE_MAX) ?? null,
                input.baseFingerprint, JSON.stringify(input.definition), input.fingerprint, input.replayId],
        );
        return row ? proposalOf(row) : null;
    }

    /** A proposal of this item, or null (another item's proposal answers as one that does not exist). */
    async function getProposal(scheduleId: string, id: string): Promise<Proposal | null> {
        await ready();
        const row = await db.getOne('SELECT * FROM cowork_proposals WHERE id = $1 AND schedule_id = $2', [id, scheduleId]);
        return row ? proposalOf(row) : null;
    }

    /** The item's proposals, newest first. */
    async function listProposals(scheduleId: string, limit = 10): Promise<Proposal[]> {
        await ready();
        const rows = await db.getAll('SELECT * FROM cowork_proposals WHERE schedule_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [scheduleId, Math.max(1, Math.min(50, limit))]);
        return rows.map(proposalOf);
    }

    /** The item's open proposal of this kind, or null. */
    async function openProposalOf(scheduleId: string, kind: ProposalKind): Promise<Proposal | null> {
        await ready();
        const row = await db.getOne(`SELECT * FROM cowork_proposals WHERE schedule_id = $1 AND kind = $2 AND status = 'open'`, [scheduleId, kind]);
        return row ? proposalOf(row) : null;
    }

    /** Decide an open proposal; answers it as decided, or null when it was not open (any more). */
    async function decideProposal(scheduleId: string, id: string, status: Exclude<ProposalStatus, 'open'>): Promise<Proposal | null> {
        await ready();
        const row = await db.getOne(
            `UPDATE cowork_proposals SET status = $3, decided_at = NOW() WHERE id = $1 AND schedule_id = $2 AND status = 'open' RETURNING *`,
            [id, scheduleId, status],
        );
        return row ? proposalOf(row) : null;
    }

    /** Every open proposal of the item that was made on another plan than `approvedFingerprint` (null: no plan) is stale. */
    async function markStale(scheduleId: string, approvedFingerprint: string | null): Promise<number> {
        await ready();
        const rows = await db.getAll(
            `UPDATE cowork_proposals SET status = 'stale', decided_at = NOW()
              WHERE schedule_id = $1 AND status = 'open' AND ($2::text IS NULL OR base_fingerprint <> $2) RETURNING id`,
            [scheduleId, approvedFingerprint],
        );
        return rows.length;
    }

    return { createProposal, recordAutoFix, getProposal, listProposals, openProposalOf, decideProposal, markStale };
}

/**
 * What the triggers and "Undo" read next to the proposals: the attempts, the item's last runs, how often the steps of
 * an approved plan ended well, the items with an approved plan, and the approved versions of a plan.
 */
export function makeCoworkPlanFacts({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Claim the item's next attempt of this kind at `now`; false while the last one is younger than `windowMs`. */
    async function claimAttempt(scheduleId: string, kind: AttemptKind, now: Date, windowMs: number): Promise<boolean> {
        await ready();
        const row = await db.getOne(
            `INSERT INTO cowork_proposal_attempts (schedule_id, kind, attempted_at) VALUES ($1, $2, $3)
             ON CONFLICT (schedule_id, kind) DO UPDATE SET attempted_at = EXCLUDED.attempted_at
              WHERE cowork_proposal_attempts.attempted_at <= $4 RETURNING schedule_id`,
            [scheduleId, kind, now.toISOString(), new Date(now.getTime() - windowMs).toISOString()],
        );
        return !!row;
    }

    /** The item's last `n` finished runs, newest first, each with the steps that failed (ids and error classes only). */
    async function lastRunFailures(scheduleId: string, n: number): Promise<RunFailures[]> {
        await ready();
        const rows = await db.getAll(LAST_RUN_FAILURES_SQL, [scheduleId, Math.max(1, Math.min(10, n))]);
        const byRun = new Map<string, RunFailures>();
        for (const r of rows) {
            const runId = String(r.run_id);
            const run = byRun.get(runId) ?? { runId, planId: text(r.plan_id), failed: [] };
            const stepId = text(r.step_id);
            if (stepId && !run.failed.some((f) => f.stepId === stepId)) run.failed.push({ stepId, errorClass: text(r.error_class) });
            // A step whose AI said it failed (core/cowork/runOutcome.mts) failed that run too: the step and a class, no reason.
            const judged = parsed(r.outcome_json) as { kind?: unknown; stepId?: unknown } | null;
            const aiStep = judged?.kind === 'ai_failed' ? text(judged.stepId) : null;
            if (aiStep && !run.failed.some((f) => f.stepId === aiStep)) run.failed.push({ stepId: aiStep, errorClass: AI_FAILED_CLASS });
            byRun.set(runId, run);
        }
        return [...byRun.values()];
    }

    /** How many runs of this approved plan each of its top-level steps ended well in. */
    async function stepSuccessCounts(scheduleId: string, planId: string): Promise<Record<string, number>> {
        await ready();
        const rows = await db.getAll(
            `SELECT s.step_id, COUNT(DISTINCT r.id)::int AS n
               FROM cowork_runs r
               JOIN automation_runs a ON a.id = r.automation_run_id OR a.root_run_id = r.automation_run_id
               JOIN automation_run_steps s ON s.run_id = a.id AND s.status = 'success' AND s.parent_step_id IS NULL
              WHERE r.schedule_id = $1 AND r.plan_id = $2 AND r.automation_run_id IS NOT NULL
              GROUP BY s.step_id`,
            [scheduleId, planId],
        );
        return Object.fromEntries(rows.map((r) => [String(r.step_id), Number(r.n) || 0]));
    }

    /** Items with an approved plan that are switched on, by id after `after` (a page of the weekly job). */
    async function itemsWithApprovedPlan(limit: number, after: string | null): Promise<string[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT id FROM cowork_schedules WHERE plan_id IS NOT NULL AND is_active = TRUE AND ($2::text IS NULL OR id > $2)
              ORDER BY id LIMIT $1`,
            [Math.max(1, Math.min(500, limit)), after],
        );
        return rows.map((r) => String(r.id));
    }

    /** One approved version of an item's plan, or null (usecases/coworkPlanVersions.mts restores it). */
    async function getPlanVersion(scheduleId: string, version: number): Promise<PlanVersion | null> {
        await ready();
        const row = await db.getOne('SELECT version, definition_json, fingerprint FROM cowork_plans WHERE schedule_id = $1 AND version = $2', [scheduleId, version]);
        return row ? { version: Number(row.version), definition: parsed(row.definition_json), fingerprint: String(row.fingerprint) } : null;
    }

    /** The newest approved version of an item's plan with this fingerprint, or null. */
    async function versionWithFingerprint(scheduleId: string, fingerprint: string): Promise<number | null> {
        await ready();
        const row = await db.getOne('SELECT MAX(version)::int AS v FROM cowork_plans WHERE schedule_id = $1 AND fingerprint = $2', [scheduleId, fingerprint]);
        return row && row.v !== null && row.v !== undefined ? Number(row.v) : null;
    }

    return { claimAttempt, lastRunFailures, stepSuccessCounts, itemsWithApprovedPlan, getPlanVersion, versionWithFingerprint };
}

/** Both, on one database. */
export function makeCoworkProposalsStore(opts: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    return { ...makeCoworkProposals(opts), ...makeCoworkPlanFacts(opts) };
}

export type CoworkProposalsStore = ReturnType<typeof makeCoworkProposalsStore>;

type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised), after the Cowork schema it refers to; storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkProposalsStore', async () => {
    await (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB();
    const db = nodeRequire('../db.js') as { exec: (sql: string) => Promise<unknown> };
    for (const sql of COWORK_PROPOSALS_DDL) await db.exec(sql);
});

let defaultStore: CoworkProposalsStore | null = null;

/** The store on the server's pool. */
export function coworkProposals(): CoworkProposalsStore {
    if (!defaultStore) defaultStore = makeCoworkProposalsStore({ ready: initDB });
    return defaultStore;
}
