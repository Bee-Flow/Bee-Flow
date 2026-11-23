/**
 * The steps of one run that followed a plan, for the item's history (routes/coworkPlanRoutes.js, which checked the
 * item is the caller's): the plan as it was approved THEN, each step with how it went, how long it took and a short
 * preview of what it got or what it wrote or sent (core/cowork/plan/planTrace.mts).
 *
 * A run is read through its item, and its steps through the plan it followed: the automation run that holds them
 * must be a run of the automation that plan was made from. A plan that waited for its owner's decision ran in more
 * than one leg; the steps are read over the whole journey (the later leg wins for a step both recorded), and its state
 * is the newest leg's. A run that followed no plan has no trace (404). A run
 * whose plan was refused before it started, or whose steps are no longer kept (the automation was deleted), answers
 * the plan's steps as never reached, and says the steps are not kept.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { RunStepRow, TraceStep } from '../core/cowork/plan/planTrace.mts';
import type { PlanRun } from '../stores/coworkPlans.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { runIsOver, traceSteps } from '../core/cowork/plan/planTrace.mts';
import { isIndependence, withAsks } from '../core/cowork/plan/planIndependence.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string }

const WAITS_FOR_A_PERSON: ReadonlySet<string> = new Set(['awaiting_approval', 'awaiting_form', 'awaiting_confirm']);
interface RunRow { id?: string; automationId?: string; status?: string; durationMs?: number | null }

export interface TraceDeps {
    store: { getPlanRun: (scheduleId: string, runId: string) => Promise<PlanRun | null> };
    /** The newest leg of the journey this run started (stores/automationStore getLatestRunInChain). */
    getLatestRunInChain: (runId: string) => Promise<RunRow | null>;
    /** The journey's step rows as one timeline (stores/automationStore getRunStepsForChain). */
    getRunStepsForChain: (runId: string) => Promise<RunStepRow[]>;
    lookups: ToolLookups;
}

function defaultDeps(): TraceDeps {
    const automations = () => nodeRequire('../stores/automationStore') as Pick<TraceDeps, 'getLatestRunInChain' | 'getRunStepsForChain'>;
    return {
        store: nodeRequire('../stores/coworkStore.js') as TraceDeps['store'],
        getLatestRunInChain: (id) => automations().getLatestRunInChain(id),
        getRunStepsForChain: (id) => automations().getRunStepsForChain(id),
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

/** The newest leg of the journey that holds this run's steps, when it is still there and runs the plan's automation. */
async function recordedRun(link: PlanRun, deps: TraceDeps): Promise<RunRow | null> {
    if (!link.automationRunId) return null;
    const run = await deps.getLatestRunInChain(link.automationRunId);
    return run && run.automationId === link.plan.automationId ? run : null;
}

export async function runTraceOf({ item, runId }: { item: Item; runId: string }, deps: TraceDeps = defaultDeps()): Promise<RunTrace> {
    const link = await deps.store.getPlanRun(item.id, runId);
    if (!link) throw new HttpError(404, 'cowork_run_no_plan', 'This run followed no plan.');
    // The plan as the run executed it: with the questions of the level it started with (none for an older run).
    const definition = withAsks(link.plan.definition as Definition, isIndependence(link.independence) ? link.independence : 'on_its_own', deps.lookups);
    const run = await recordedRun(link, deps);
    if (!run) {
        return { runId, planVersion: link.plan.version, recorded: false, done: true, durationMs: null, steps: traceSteps(definition, [], { done: true, simulated: false }, deps.lookups) };
    }
    const done = runIsOver(run.status);
    // A journey that waits for a person is not over for its steps: the ones after the decision are still to come.
    const waiting = WAITS_FOR_A_PERSON.has(run.status ?? '');
    const rows = await deps.getRunStepsForChain(link.automationRunId as string);
    return {
        runId, planVersion: link.plan.version, recorded: true, done,
        durationMs: run.durationMs ?? null,
        steps: traceSteps(definition, rows, { done: done && !waiting, simulated: false }, deps.lookups),
    };
}
