/**
 * The plans of Cowork items (next to stores/coworkStore.js, which re-exports these; schema in
 * ./ddl/cowork-plans-2026-11.js).
 *
 *   - an item names the automation its plan is made from (`plan_automation_id`) and the approved plan a run executes
 *     (`plan_id`);
 *   - approving writes the plan AS APPROVED as a new version and points the item at it, in one transaction: an item
 *     never points at a plan that was not written, and two approvals at once give two versions, never one row twice;
 *   - taking the plan off clears both pointers; the approved versions stay as the item's history until it is deleted.
 *
 * Who may do this is the caller's question (the item's owner, usecases/coworkPlan.mts); every statement is keyed on
 * the schedule.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    run: (sql: string, params?: unknown[]) => Promise<unknown>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};

/** One approved plan. `definition` and `permissions` are exactly what was approved. */
export interface ApprovedPlan {
    id: string;
    scheduleId: string;
    automationId: string;
    version: number;
    definition: unknown;
    permissions: unknown;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string | null;
}

/** A run that followed a plan: the plan it ran, and the automation run that holds its steps (null: it never started). */
/** A stored JSON list of step ids; none when absent or unreadable. */
function stepList(value: unknown): string[] {
    if (typeof value !== 'string' || !value) return [];
    try {
        const list = JSON.parse(value) as unknown;
        return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export interface PlanRun {
    runId: string;
    automationRunId: string | null;
    plan: ApprovedPlan;
    /** The level the run started with; null for a run from before levels (it asked nothing more). */
    independence: string | null;
    /** The steps it let go on their own (core/cowork/planTrust.mts). */
    trustedSteps: string[];
}

export interface ApproveInput {
    scheduleId: string;
    automationId: string;
    definition: unknown;
    permissions: unknown;
    fingerprint: string;
    approvedBy: string;
}

function parse(text: unknown): unknown {
    if (typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
}

function rowToPlan(r: Row | null | undefined): ApprovedPlan | null {
    if (!r) return null;
    return {
        id: String(r.id),
        scheduleId: String(r.schedule_id),
        automationId: String(r.automation_id),
        version: Number(r.version),
        definition: parse(r.definition_json),
        permissions: parse(r.permissions_json),
        fingerprint: String(r.fingerprint),
        approvedBy: String(r.approved_by),
        approvedAt: r.approved_at ? new Date(r.approved_at as string).toISOString() : null,
    };
}

/** Its owner chose to take the plan off, so an item that waited for its steps (./coworkSetup.mts) waits no longer. */
const DETACH_SQL = `
    UPDATE cowork_schedules SET plan_automation_id = NULL, plan_id = NULL,
           setup_state = CASE WHEN setup_state IN ('wanted', 'failed') THEN 'ai' ELSE setup_state END
     WHERE id = $1`;

export function makeCoworkPlans({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /**
     * Name the automation this item's plan is made from. An approved plan, if any, stays until a new one is approved.
     * `onlyIfNone`: only when the item names none yet (the planner, which drafted for an item without a plan). Answers
     * whether the item now names it.
     */
    async function attachPlanAutomation(scheduleId: string, automationId: string, { onlyIfNone = false, replaceId }: { onlyIfNone?: boolean; replaceId?: string } = {}): Promise<boolean> {
        await ready();
        const row = replaceId
            ? await db.getOne('UPDATE cowork_schedules SET plan_automation_id = $2, plan_id = NULL WHERE id = $1 AND plan_automation_id = $3 RETURNING id', [scheduleId, automationId, replaceId])
            : await db.getOne('UPDATE cowork_schedules SET plan_automation_id = $2 WHERE id = $1 AND (NOT $3 OR plan_automation_id IS NULL) RETURNING id', [scheduleId, automationId, onlyIfNone]);
        return !!row;
    }

    /** Take the plan off the item: it runs as a prompt or as its agent again. */
    async function detachPlan(scheduleId: string): Promise<void> {
        await ready();
        await db.run(DETACH_SQL, [scheduleId]);
    }

    /** Write the plan as approved, as the item's next version, and point the item at it. */
    async function approvePlan(input: ApproveInput): Promise<ApprovedPlan> {
        await ready();
        return db.withTransaction(async (client) => {
            // The item's row is the lock: two approvals of one item take their version numbers one after the other.
            const locked = await client.query('SELECT id FROM cowork_schedules WHERE id = $1 FOR UPDATE', [input.scheduleId]);
            if (locked.rows.length === 0) throw new Error(`Cowork item ${input.scheduleId} does not exist`);
            const last = await client.query('SELECT COALESCE(MAX(version), 0)::int AS v FROM cowork_plans WHERE schedule_id = $1', [input.scheduleId]);
            const version = (Number(last.rows[0]?.v) || 0) + 1;
            const inserted = await client.query(
                `INSERT INTO cowork_plans (id, schedule_id, automation_id, version, definition_json, permissions_json, fingerprint, approved_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [randomUUID(), input.scheduleId, input.automationId, version, JSON.stringify(input.definition), JSON.stringify(input.permissions), input.fingerprint, input.approvedBy],
            );
            const plan = rowToPlan(inserted.rows[0]) as ApprovedPlan;
            await client.query('UPDATE cowork_schedules SET plan_id = $2, plan_automation_id = $3 WHERE id = $1', [input.scheduleId, plan.id, input.automationId]);
            return plan;
        });
    }

    /** The approved plan a run of this item executes: the one the item points at, and only if it is this item's. */
    async function getApprovedPlan(scheduleId: string): Promise<ApprovedPlan | null> {
        await ready();
        return rowToPlan(await db.getOne(
            `SELECT p.* FROM cowork_plans p JOIN cowork_schedules s ON s.plan_id = p.id
              WHERE s.id = $1 AND p.schedule_id = s.id`,
            [scheduleId],
        ));
    }

    /** Note on a run of a plan which plan it ran and which automation run holds its step trace. */
    async function linkPlanRun(runId: string | null | undefined, { planId, automationRunId, independence, trustedSteps }: { planId: string; automationRunId?: string | null; independence?: string | null; trustedSteps?: string[] | null }): Promise<void> {
        if (!runId) return;
        await ready();
        await db.run(
            `UPDATE cowork_runs SET plan_id = $2, automation_run_id = COALESCE($3, automation_run_id), independence = COALESCE($4, independence),
                    trusted_steps = COALESCE($5, trusted_steps) WHERE id = $1`,
            [runId, planId, automationRunId ?? null, independence ?? null, trustedSteps ? JSON.stringify(trustedSteps) : null],
        );
    }

    /** The owner's choice of how independent the item's plan may be (NULL: not chosen). */
    async function setIndependence(scheduleId: string, level: string | null): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_schedules SET independence = $2 WHERE id = $1', [scheduleId, level]);
    }

    /**
     * Runs of this version of the plan its owner let through, since the last one they stopped: a run that waited for
     * a decision and then ended well. "On its own" is offered from ON_ITS_OWN_AFTER on (core/cowork/plan/planIndependence.mts).
     */
    async function countLetThrough(scheduleId: string, planId: string): Promise<number> {
        await ready();
        const row = await db.getOne(
            `SELECT COUNT(*)::int AS n FROM cowork_runs r
              WHERE r.schedule_id = $1 AND r.plan_id = $2 AND r.status = 'success' AND r.decided_at IS NOT NULL
                AND r.decided_at > COALESCE((SELECT MAX(x.decided_at) FROM cowork_runs x
                     WHERE x.schedule_id = $1 AND x.plan_id = $2 AND x.status = 'error' AND x.decided_at IS NOT NULL), '-infinity'::timestamptz)`,
            [scheduleId, planId],
        );
        return Number(row?.n ?? 0);
    }

    /**
     * The plan one run of this item followed, as it was approved then (a later approval does not rewrite history).
     * Null for a run of another item, a run that followed no plan, and a plan that is not this item's.
     */
    async function getPlanRun(scheduleId: string, runId: string): Promise<PlanRun | null> {
        await ready();
        const row = await db.getOne(
            `SELECT p.*, r.automation_run_id AS run_automation_run_id, r.independence AS run_independence, r.trusted_steps AS run_trusted_steps
               FROM cowork_runs r JOIN cowork_plans p ON p.id = r.plan_id
              WHERE r.id = $2 AND r.schedule_id = $1 AND p.schedule_id = r.schedule_id`,
            [scheduleId, runId],
        );
        const plan = rowToPlan(row);
        if (!row || !plan) return null;
        const independence = row.run_independence ? String(row.run_independence) : null;
        return { runId, automationRunId: row.run_automation_run_id ? String(row.run_automation_run_id) : null, plan, independence, trustedSteps: stepList(row.run_trusted_steps) };
    }

    return { attachPlanAutomation, detachPlan, approvePlan, getApprovedPlan, linkPlanRun, getPlanRun, setIndependence, countLetThrough };
}

/**
 * The journeys of plan runs (core/cowork/planHeldDefinition.mts, core/cowork/planRunFollowUp.mts): which approved plan
 * a journey of the engine runs, and the runs that wait for their owner's decision.
 */
export function makeCoworkPlanJourneys({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /**
     * The approved plan a journey of the automation engine is running, by the engine's run id of its first leg: what
     * the run continues on after a pause. Null for a run no Cowork run started.
     */
    async function getPlanOfAutomationRun(automationRunId: string): Promise<(ApprovedPlan & { runId: string; userId: string; title: string | null; independence: string | null; trustedSteps: string[] }) | null> {
        await ready();
        const row = await db.getOne(
            `SELECT p.*, r.id AS cowork_run_id, r.independence AS run_independence, r.trusted_steps AS run_trusted_steps, s.user_id AS owner_id, s.title AS item_title
               FROM cowork_runs r
               JOIN cowork_plans p ON p.id = r.plan_id AND p.schedule_id = r.schedule_id
               JOIN cowork_schedules s ON s.id = r.schedule_id
              WHERE r.automation_run_id = $1
              ORDER BY r.started_at DESC LIMIT 1`,
            [automationRunId],
        );
        const plan = rowToPlan(row);
        if (!row || !plan) return null;
        return {
            ...plan, runId: String(row.cowork_run_id), userId: String(row.owner_id), title: row.item_title ? String(row.item_title) : null,
            independence: row.run_independence ? String(row.run_independence) : null,
            trustedSteps: stepList(row.run_trusted_steps),
        };
    }

    /**
     * Close a Cowork run that was waiting for a decision, once its journey ended. Only a run that is still waiting is
     * changed (a second report of the same end changes nothing); answers whether it was.
     */
    async function closeWaitingRun(runId: string, end: { status: 'success' | 'error'; result: string | null; error: string | null }): Promise<boolean> {
        await ready();
        const closed = await db.getOne(
            `UPDATE cowork_runs
                SET status = $2, result = COALESCE($3, result), error = $4, produced_output = $5, decided_at = NOW(),
                    duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int, finished_at = NOW()
              WHERE id = $1 AND status = 'waiting'
          RETURNING id, schedule_id`,
            [runId, end.status, end.result, end.error, end.status === 'success' && !!end.result],
        );
        if (!closed) return false;
        // The item says how its latest run went: this one, unless a newer run has started since.
        await db.run(
            `UPDATE cowork_schedules SET last_status = $2, last_result = COALESCE($3, $4, last_result)
              WHERE id = $1 AND NOT EXISTS (
                  SELECT 1 FROM cowork_runs n WHERE n.schedule_id = $1 AND n.started_at > (SELECT started_at FROM cowork_runs WHERE id = $5))`,
            [closed.schedule_id, end.status, end.result, end.error, runId],
        );
        return true;
    }

    /** Plan runs that wait for a decision, oldest first, after the cursor `after`, with the journey each belongs to. */
    async function listWaitingRuns(limit: number, after: { startedAt: string; id: string } | null = null): Promise<Array<{ id: string; automationRunId: string; startedAt: string }>> {
        await ready();
        const rows = await db.getAll(
            `SELECT id, automation_run_id, started_at FROM cowork_runs
              WHERE status = 'waiting' AND automation_run_id IS NOT NULL
                AND ($2::timestamptz IS NULL OR (started_at, id) > ($2::timestamptz, $3::text))
              ORDER BY started_at ASC, id ASC LIMIT $1`,
            [Math.max(1, Math.min(500, Math.floor(limit) || 1)), after?.startedAt ?? null, after?.id ?? null],
        );
        return rows.map((r) => ({ id: String(r.id), automationRunId: String(r.automation_run_id), startedAt: new Date(r.started_at as string).toISOString() }));
    }

    return { getPlanOfAutomationRun, closeWaitingRun, listWaitingRuns };
}
