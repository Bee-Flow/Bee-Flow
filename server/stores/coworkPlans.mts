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

export function makeCoworkPlans({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Name the automation this item's plan is made from. An approved plan, if any, stays until a new one is approved. */
    async function attachPlanAutomation(scheduleId: string, automationId: string): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_schedules SET plan_automation_id = $2 WHERE id = $1', [scheduleId, automationId]);
    }

    /** Take the plan off the item: it runs as a prompt or as its agent again. */
    async function detachPlan(scheduleId: string): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_schedules SET plan_automation_id = NULL, plan_id = NULL WHERE id = $1', [scheduleId]);
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
    async function linkPlanRun(runId: string | null | undefined, { planId, automationRunId }: { planId: string; automationRunId?: string | null }): Promise<void> {
        if (!runId) return;
        await ready();
        await db.run('UPDATE cowork_runs SET plan_id = $2, automation_run_id = COALESCE($3, automation_run_id) WHERE id = $1', [runId, planId, automationRunId ?? null]);
    }

    return { attachPlanAutomation, detachPlan, approvePlan, getApprovedPlan, linkPlanRun };
}
