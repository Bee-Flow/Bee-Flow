/**
 * The steps of one run that followed a plan, for the item's history (routes/coworkPlanRoutes.js, which checked the
 * item is the caller's): the plan as it was approved THEN, each step with how it went, how long it took and a short
 * preview of what it got or what it wrote or sent (core/cowork/plan/planTrace.mts).
 *
 * A run is read through its item, and its steps through the plan it followed: the automation run that holds them
 * must be a run of the automation that plan was made from. A run that followed no plan has no trace (404). A run
 * whose plan was refused before it started, or whose steps are no longer kept (the automation was deleted), answers
 * the plan's steps as never reached, and says the steps are not kept.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { RunStepRow, TraceStep } from '../core/cowork/plan/planTrace.mts';
import type { PlanRun } from '../stores/coworkPlans.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { runIsOver, traceSteps } from '../core/cowork/plan/planTrace.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string }
interface RunRow { id?: string; automationId?: string; status?: string; durationMs?: number | null }

export interface TraceDeps {
    store: { getPlanRun: (scheduleId: string, runId: string) => Promise<PlanRun | null> };
    getRun: (runId: string) => Promise<RunRow | null>;
    getRunSteps: (runId: string) => Promise<RunStepRow[]>;
    lookups: ToolLookups;
}

function defaultDeps(): TraceDeps {
    const automations = () => nodeRequire('../stores/automationStore') as { getRun: TraceDeps['getRun']; getRunSteps: TraceDeps['getRunSteps'] };
    return {
        store: nodeRequire('../stores/coworkStore.js') as TraceDeps['store'],
        getRun: (id) => automations().getRun(id),
        getRunSteps: (id) => automations().getRunSteps(id),
        lookups: toolLookups(),
    };
}

export interface RunTrace {
    runId: string;
    /** The version of the plan this run followed. */
    planVersion: number;
    /** The steps were recorded and are still kept; false: the plan's steps are listed without how they went. */
    recorded: boolean;
    /** Nothing more happens by itself: the run finished, failed, or waits for a person. */
    done: boolean;
    durationMs: number | null;
    steps: TraceStep[];
}

/** The automation run that holds this run's steps, when it is still there and is a run of the plan's automation. */
async function recordedRun(link: PlanRun, deps: TraceDeps): Promise<RunRow | null> {
    if (!link.automationRunId) return null;
    const run = await deps.getRun(link.automationRunId);
    return run && run.automationId === link.plan.automationId ? run : null;
}

export async function runTraceOf({ item, runId }: { item: Item; runId: string }, deps: TraceDeps = defaultDeps()): Promise<RunTrace> {
    const link = await deps.store.getPlanRun(item.id, runId);
    if (!link) throw new HttpError(404, 'cowork_run_no_plan', 'This run followed no plan.');
    const definition = link.plan.definition as Definition;
    const run = await recordedRun(link, deps);
    if (!run) {
        return { runId, planVersion: link.plan.version, recorded: false, done: true, durationMs: null, steps: traceSteps(definition, [], { done: true, simulated: false }, deps.lookups) };
    }
    const done = runIsOver(run.status);
    const rows = await deps.getRunSteps(link.automationRunId as string);
    return {
        runId, planVersion: link.plan.version, recorded: true, done,
        durationMs: run.durationMs ?? null,
        steps: traceSteps(definition, rows, { done, simulated: false }, deps.lookups),
    };
}
