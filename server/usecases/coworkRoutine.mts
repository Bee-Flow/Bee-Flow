/**
 * "Make it routine", for the owner of an agent or prompt item (routes/coworkPlanRoutes.js):
 *
 *   advice   what its last good runs did, in names and counts (core/cowork/routineSignals.mts), and whether fixed
 *            steps are worth proposing;
 *   hints    what the planner is told when it makes the routine (routes/coworkPlannerRoutes.js, `fromRuns`);
 *   compare  the proof: a try-out of the routine next to the last run the AI made, item by item, with the time each
 *            took (core/cowork/routineCompare.mts).
 *
 * Nothing changes until the owner approves the plan: the item keeps running as it does, and its runs stay its history.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { routineSignals, hintsOf, MIN_RUNS, type RoutineSignals, type RunLike } from '../core/cowork/routineSignals.mts';
import { compareResults, type Comparison } from '../core/cowork/routineCompare.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; planAutomationId?: string | null }
interface Run extends RunLike { id: string; result?: string | null; durationMs?: number | null; planId?: string | null }
interface StepRow { stepId?: string; step_id?: string; input?: unknown; output?: unknown }

export interface RoutineDeps {
    listRuns: (scheduleId: string, opts: { limit: number }) => Promise<Run[]>;
    tryStateOf: (input: { item: Item; tryId: string }) => Promise<{ done: boolean; durationMs: number | null; status: string }>;
    getRunSteps: (runId: string) => Promise<StepRow[]>;
    getAutomation: (id: string) => Promise<{ userId?: string; definition?: unknown } | null>;
    lookups: ToolLookups;
}

const defaults = (): RoutineDeps => {
    const automations = () => nodeRequire('../stores/automationStore') as { getRunSteps: RoutineDeps['getRunSteps']; getAutomation: RoutineDeps['getAutomation'] };
    return {
        listRuns: (id, opts) => (nodeRequire('../stores/coworkStore.js') as { listRuns: RoutineDeps['listRuns'] }).listRuns(id, opts),
        tryStateOf: (input) => (nodeRequire('./coworkPlanTry.mts') as { tryStateOf: RoutineDeps['tryStateOf'] }).tryStateOf(input),
        getRunSteps: (id) => automations().getRunSteps(id),
        getAutomation: (id) => automations().getAutomation(id),
        lookups: toolLookups(),
    };
};

export interface RoutineAdvice { applicable: boolean; signals: RoutineSignals | null; needed: number }

/** What the last good runs did. Not applicable to an item that already runs a plan. */
export async function routineAdviceOf(item: Item, deps: RoutineDeps = defaults()): Promise<RoutineAdvice> {
    if (item.planAutomationId) return { applicable: false, signals: null, needed: MIN_RUNS };
    return { applicable: true, signals: routineSignals(await deps.listRuns(item.id, { limit: 25 })), needed: MIN_RUNS };
}

/** The planner's hints; refused while there is not enough to go on. */
export async function hintsFor(item: Item, deps: RoutineDeps = defaults()): Promise<string> {
    const advice = await routineAdviceOf(item, deps);
    if (!advice.signals?.worthIt) throw new HttpError(409, 'cowork_routine_refused', `Making it routine needs ${MIN_RUNS} runs that went well and did the same thing each time.`);
    return hintsOf(advice.signals);
}

/** The longest text a result step's row holds (a try-out keeps it as `wouldNotify`): what the result said. */
function deliveredText(row: StepRow | undefined): string {
    let best = '';
    const visit = (v: unknown, depth: number): void => {
        if (typeof v === 'string') { if (v.length > best.length) best = v; return; }
        if (!v || typeof v !== 'object' || depth > 4) return;
        for (const inner of Object.values(v)) visit(inner, depth + 1);
    };
    visit(row?.output, 0);
    if (!best) visit(row?.input, 0);
    return best;
}

export interface RoutineComparison extends Comparison {
    beforeText: string;
    afterText: string;
    beforeMs: number | null;
    afterMs: number | null;
}

/** The proof: the try-out `tryId` of the item's routine next to the last run the AI made. */
export async function compareTry({ item, tryId }: { item: Item; tryId: string }, deps: RoutineDeps = defaults()): Promise<RoutineComparison> {
    const tried = await deps.tryStateOf({ item, tryId });
    if (!tried.done) throw new HttpError(409, 'cowork_routine_refused', 'The try-out is still running.');
    const last = (await deps.listRuns(item.id, { limit: 25 })).find((r) => r.status === 'success' && !r.planId && typeof r.result === 'string' && r.result.trim());
    if (!last) throw new HttpError(409, 'cowork_routine_refused', 'There is no run the AI made to compare with.');
    const automation = item.planAutomationId ? await deps.getAutomation(item.planAutomationId) : null;
    const deliverIds = new Set(planViewOf((automation?.definition ?? null) as Definition | null, deps.lookups).steps.filter((s) => s.kind === 'deliver').map((s) => s.id));
    const rows = await deps.getRunSteps(tryId);
    const delivered = rows.filter((r) => deliverIds.has(String(r.stepId ?? r.step_id ?? ''))).at(-1);
    const beforeText = String(last.result);
    const afterText = deliveredText(delivered);
    return { ...compareResults(beforeText, afterText), beforeText, afterText, beforeMs: last.durationMs ?? null, afterMs: tried.durationMs };
}
