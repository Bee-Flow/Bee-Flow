/**
 * "Try it first": run the plan of a Cowork item once without it changing or sending anything, and read how that
 * went, step by step (routes/coworkPlanRoutes.js, which checked the item is the caller's).
 *
 * The try-out is the automation runner's dry run: steps that only read run for real, on the owner's real data, and
 * every step that would change or send something is simulated. So the owner sees what the plan would have read this
 * morning and what it would have done with it, before approving anything.
 *
 *   - START answers as soon as the run exists, with its id and the fingerprint of the plan that is being tried; the
 *     run goes on in the background. A plan with findings is not tried (it is not a plan Cowork runs), and neither
 *     is one for an owner the runner would refuse.
 *   - READ answers the run so far, per plan step: whether it ran, how long it took, and a short preview of what it
 *     got or WOULD have written or sent (core/cowork/plan/planTrace.mts, the reading a real run's history uses too).
 *     A try-out in which a step that works through a list found none in what an earlier step really returned is no
 *     pass (core/cowork/runOutcome.mts): it ends as an error, with the plain sentence of each such reference.
 *
 * A try-out belongs to its item: the run must be a dry run of the automation this item's plan is made from.
 */

import { createRequire } from 'node:module';
import { withIsolatedScripts } from '../core/cowork/plan/planRunCopy.mts';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { RunStepRow, TraceStep } from '../core/cowork/plan/planTrace.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { runIsOver, traceSteps } from '../core/cowork/plan/planTrace.mts';
import { unresolvedOf, unresolvedSentence, type StepRecord } from '../core/cowork/runOutcome.mts';
import { recordedStepsOf } from '../core/cowork/replay/recordingOf.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { warn: (msg: string) => void };

interface Item { id: string; userId: string; planAutomationId?: string | null }
type AutomationRow = SourceRow;
interface RunRow { id?: string; automationId?: string; mode?: string; status?: string; summary?: string | null; error?: string | null; durationMs?: number | null }

export interface TryDeps {
    getAutomation: (id: string) => Promise<AutomationRow | null>;
    /** The automation is managed by a Solution stage: no plan source (core/cowork/plan/planSource.mts). */
    isManaged: (automation: AutomationRow) => Promise<boolean>;
    /** The owner's licence covers a step that waits for a decision (core/cowork/plan/planLicence.mts). */
    mayAsk: MayAsk;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    executeAutomation: (automation: AutomationRow, opts: Record<string, unknown>) => Promise<RunRow | null | undefined>;
    getRun: (runId: string) => Promise<RunRow | null>;
    getRunSteps: (runId: string) => Promise<RunStepRow[]>;
    /** The kept full copy of a step output the history had to cut. */
    getRunFullOutput?: (runId: string, stepId: string, attempts: number) => Promise<unknown>;
    lookups: ToolLookups;
}

function defaultDeps(): TryDeps {
    const store = () => nodeRequire('../stores/automationStore') as { getAutomation: TryDeps['getAutomation']; getRun: TryDeps['getRun']; getRunSteps: TryDeps['getRunSteps']; getRunFullOutput: NonNullable<TryDeps['getRunFullOutput']> };
    return {
        getAutomation: (id) => store().getAutomation(id),
        getRun: (id) => store().getRun(id),
        getRunSteps: (id) => store().getRunSteps(id),
        getRunFullOutput: (runId, stepId, attempts) => store().getRunFullOutput(runId, stepId, attempts),
        isManaged: isManagedByStage,
        mayAsk: mayAskByLicence,
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: TryDeps['ownerRefusal'] }).ownerRefusal(owner),
        executeAutomation: (a, o) => (nodeRequire('../core/automationRunner') as { executeAutomation: TryDeps['executeAutomation'] }).executeAutomation(a, o),
        lookups: toolLookups(),
    };
}

export interface TryState {
    tryId: string;
    status: string;
    /** The run is over: nothing more will change. */
    done: boolean;
    summary: string | null;
    error: string | null;
    durationMs: number | null;
    steps: TraceStep[];
    /** References that found no list in what the try-out really read, as plain sentences; empty or absent when none. */
    problems?: string[];
}

/** The automation this item's plan is made from, when it is still the owner's. */
async function planAutomation(item: Item, deps: TryDeps): Promise<AutomationRow> {
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!automation) throw new HttpError(409, 'cowork_plan_refused', 'This item has no plan to try.');
    return automation;
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/** Start a try-out of the item's plan as it is now. Answers once the run exists; the run goes on by itself. */
export async function startTry({ item }: { item: Item }, deps: TryDeps = defaultDeps()): Promise<{ tryId: string; fingerprint: string }> {
    const automation = await planAutomation(item, deps);
    const definition = automation.definition as Definition;
    const findings = [...checkPlan(definition, deps.lookups), ...await licenceFindings(definition, { userId: item.userId, organizationId: automation.organizationId ?? null }, deps.mayAsk)];
    if (findings.length > 0) {
        throw new HttpError(422, 'cowork_plan_not_allowed', `This plan cannot be tried yet: ${findings[0]?.message ?? ''}`);
    }
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: automation.organizationId ?? null });
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', REFUSAL_TEXT[refusal]);

    const tryId = await new Promise<string>((resolve, reject) => {
        // The plan that was read here is the one that is tried (a spread row with its own definition runs exactly that).
        // Its scripts run outside the API process, as in a real run (core/cowork/plan/planRunCopy.mts).
        deps.executeAutomation({ ...automation, definition: withIsolatedScripts(definition) }, {
            triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: item.userId, origin: 'api',
            // Nobody answers a pause in a try-out: an approval is answered with a marked, made-up answer.
            pausesRequested: false,
            onRunCreated: (run: { id?: string }) => { if (run?.id) resolve(run.id); },
        }).then((row) => {
            if (row?.id) resolve(row.id);
            else reject(new Error('The try-out did not start.'));
        }).catch((e: Error) => {
            // After the id was handed out this rejects nothing: the run's own row says how it ended.
            log.warn(`[Cowork] try-out of ${item.id} ended with an error: ${e.message}`);
            reject(e);
        });
    });
    return { tryId, fingerprint: planFingerprint(definition) };
}

/** A made-up output (a simulated step) says nothing about what the real one returns. */
const synthesised = (s: StepRecord): boolean => !!s.output && typeof s.output === 'object' && (s.output as { _dryRunSynthesised?: unknown })._dryRunSynthesised === true;

/** The references of a finished try-out that found no list in what an earlier step really returned. */
async function problemsOf(definition: Definition, tryId: string, deps: TryDeps): Promise<string[]> {
    try {
        const recorded = await recordedStepsOf(tryId, {
            getRun: async () => null,
            getRunStepsForChain: async (id) => (await deps.getRunSteps(id)).map((r) => ({ ...r, runId: id })),
            getRunFullOutput: deps.getRunFullOutput ?? (async () => null),
        });
        const real = new Map([...recorded].filter(([, s]) => !synthesised(s)));
        return unresolvedOf(definition, real, deps.lookups).map(unresolvedSentence);
    } catch (e) {
        log.warn(`[Cowork] try-out ${tryId}: the references could not be read: ${(e as Error).message}`);
        return [];
    }
}

/** How a try-out is going, per plan step. */
export async function tryStateOf({ item, tryId }: { item: Item; tryId: string }, deps: TryDeps = defaultDeps()): Promise<TryState> {
    const automation = await planAutomation(item, deps);
    const run = await deps.getRun(tryId);
    if (!run || run.automationId !== automation.id || run.mode !== 'dry_run') {
        throw new HttpError(404, 'cowork_plan_refused', 'That try-out does not exist.');
    }
    const status = run.status ?? 'running';
    const done = runIsOver(status);
    const steps = traceSteps(automation.definition as Definition, await deps.getRunSteps(tryId), { done, simulated: true }, deps.lookups);
    const problems = done && status === 'success' ? await problemsOf(automation.definition as Definition, tryId, deps) : [];
    return {
        tryId, status: problems.length > 0 ? 'error' : status, done,
        summary: run.summary ?? null, error: problems[0] ?? run.error ?? null, durationMs: run.durationMs ?? null, steps, problems,
    };
}
