/**
 * The last try-out of an item's plan (cowork_schedules.plan_try_json): which automation and which fingerprint it tried,
 * how it ended, and whether the plan needs a passing try-out before it is approved (a plan Cowork drafted itself:
 * usecases/coworkPlanner.mts). usecases/coworkPlanTryOut.mts writes it; usecases/coworkPlan.mts reads it for the plan
 * card and for approval.
 *
 * Counts, the plan's step titles and the plan's own sentences only: never a value the try-out read. When Cowork fixed
 * the wiring of the plan before it tried it, which steps now wait for or read from which (step ids).
 */

import { createRequire } from 'node:module';
import type { CoworkDb as Db } from './lib/coworkDb.mts';
import type { TrySummary } from '../core/cowork/plan/planTryFacts.mts';
import type { WiringChange } from '../core/cowork/plan/planWiringFix.mts';

const nodeRequire = createRequire(import.meta.url);

export type TryStatus = 'running' | 'passed' | 'failed' | 'untried';

export interface PlanTryRecord {
    automationId: string;
    fingerprint: string;
    tryId: string | null;
    status: TryStatus;
    /** The plan may not be approved from its card until a try-out of exactly this plan passed. */
    required: boolean;
    summary: TrySummary | null;
    /** Why it did not pass, as plain sentences. */
    problems: string[];
    /** How many try-outs the making of the plan took. */
    rounds: number;
    at: string;
    /** Cowork fixed the wiring of exactly this plan before it was tried (usecases/coworkPlanWiringRepair.mts): step ids only. */
    wiring?: WiringChange[];
}

const STATUSES: ReadonlySet<string> = new Set(['running', 'passed', 'failed', 'untried']);
const MAX_PROBLEMS = 8;
const TEXT_MAX = 400;
const MAX_CHANGES = 20;
const ID_MAX = 120;

const isStepId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;
const isChange = (c: unknown): c is WiringChange => {
    const v = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return (v.kind === 'waits' || v.kind === 'reads') && isStepId(v.stepId) && isStepId(v.otherId);
};
/** What a fix of the wiring changed, as kept: the three fields, step ids only, at most MAX_CHANGES. */
const changesOf = (raw: unknown): WiringChange[] => (Array.isArray(raw) ? raw : []).filter(isChange).slice(0, MAX_CHANGES)
    .map((c) => ({ kind: c.kind, stepId: c.stepId, otherId: c.otherId }));

function recordOf(raw: unknown): PlanTryRecord | null {
    if (typeof raw !== 'string' || !raw) return null;
    let v: Record<string, unknown>;
    try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
    if (!v || typeof v.automationId !== 'string' || typeof v.fingerprint !== 'string' || !STATUSES.has(String(v.status))) return null;
    return {
        automationId: v.automationId, fingerprint: v.fingerprint, tryId: typeof v.tryId === 'string' ? v.tryId : null, status: v.status as TryStatus,
        required: v.required === true, summary: (v.summary as TrySummary | null) ?? null,
        problems: Array.isArray(v.problems) ? v.problems.filter((p): p is string => typeof p === 'string') : [],
        rounds: typeof v.rounds === 'number' ? v.rounds : 0, at: typeof v.at === 'string' ? v.at : '',
        ...(Array.isArray(v.wiring) ? { wiring: changesOf(v.wiring) } : {}),
    };
}

function clean(r: PlanTryRecord): PlanTryRecord {
    const { wiring, ...rest } = r;
    return { ...rest, problems: r.problems.slice(0, MAX_PROBLEMS).map((p) => p.slice(0, TEXT_MAX)), ...(wiring ? { wiring: changesOf(wiring) } : {}) };
}

export function makeCoworkPlanTries({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    async function getPlanTry(scheduleId: string): Promise<PlanTryRecord | null> {
        await ready();
        const row = await db.getOne('SELECT plan_try_json FROM cowork_schedules WHERE id = $1', [scheduleId]);
        return row ? recordOf(row.plan_try_json) : null;
    }

    async function setPlanTry(scheduleId: string, record: PlanTryRecord): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_schedules SET plan_try_json = $2 WHERE id = $1', [scheduleId, JSON.stringify(clean(record))]);
    }

    /** Close the try-out `tryId` as it ended, when it is still the item's last one and still running. */
    async function closePlanTry(scheduleId: string, tryId: string, ended: Pick<PlanTryRecord, 'status' | 'summary' | 'problems'>): Promise<boolean> {
        const now = await getPlanTry(scheduleId);
        if (!now || now.tryId !== tryId || now.status !== 'running') return false;
        await setPlanTry(scheduleId, { ...now, ...ended, at: new Date().toISOString() });
        return true;
    }

    return { getPlanTry, setPlanTry, closePlanTry };
}

export type CoworkPlanTries = ReturnType<typeof makeCoworkPlanTries>;

let defaultStore: CoworkPlanTries | null = null;

/** The store on the server's pool, after the Cowork schema. */
export function coworkPlanTries(): CoworkPlanTries {
    if (!defaultStore) {
        defaultStore = makeCoworkPlanTries({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    }
    return defaultStore;
}
