/**
 * A plan run that waited for its owner's decision, followed to its end.
 *
 * A plan run that reaches an approval step closes in Cowork as 'waiting' (./planRun.mts): the item's schedule moves
 * on, and the decision is made under Approvals. The engine then continues the journey in a new leg, on the plan as
 * approved (./planHeldDefinition.mts). When that journey ends, this module closes the Cowork run for good: success
 * with what the run produced, or error with its reason, and tells the owner once when the plan does not do so itself
 * (a plan run's own failure notifications are off: ./plan/planRunCopy.mts).
 *
 * Two ways to hear of the end:
 *   - the engine's run events (core/runEventBus.js), on the server that ran the last leg, at once;
 *   - a sweep, every few minutes, of waiting runs whose journey ended unheard: the server restarted, or the event was
 *     missed. The store only closes a run that is still waiting, so hearing an end twice changes nothing.
 *
 * `start()` is called from the Cowork runner's start (boot): requiring this module starts nothing.
 */

import { createRequire } from 'node:module';
import type { Definition } from './plan/planTypes.mts';
import { planViewOf } from './plan/planView.mts';
import { toolLookups } from './plan/planLookups.mts';
import { NOTIFICATION } from './runShared.mts';
import { resultTextOf } from './planRun.mts';
import { runEnded } from './runEnded.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** A run of the engine as far as this module reads it. */
interface Leg { id?: string; status?: string | null; error?: string | null; summary?: string | null }
interface PlanOfRun { runId: string; userId: string; title: string | null; scheduleId: string; definition: unknown }
interface WaitingRun { id: string; automationRunId: string; startedAt: string }
interface StepRow { status?: string; output?: unknown }

export interface FollowUpDeps {
    getPlanOfAutomationRun: (automationRunId: string) => Promise<PlanOfRun | null>;
    closeWaitingRun: (runId: string, end: { status: 'success' | 'error'; result: string | null; error: string | null }) => Promise<boolean>;
    /** Waiting runs in start order, after `after` (a cursor of the last one read), at most `limit`. */
    listWaitingRuns: (limit: number, after?: { startedAt: string; id: string } | null) => Promise<WaitingRun[]>;
    getLatestRunInChain: (runId: string) => Promise<Leg | null>;
    /** The journey's step rows as one timeline (stores/automationStore getRunStepsForChain). */
    getRunStepsForChain: (runId: string) => Promise<StepRow[]>;
    createNotification: (n: Record<string, unknown>) => Promise<unknown>;
    onRunEvent: (type: string, handler: (event: RunEnd) => void) => () => void;
    /** Count the owner's decisions on the questions of the journey (./planTrust.mts). */
    recordDecisions?: (plan: { scheduleId: string; definition: unknown }, journeyId: string) => Promise<unknown>;
}

/** What the engine says when a run ends (core/runEventBus.js). */
export interface RunEnd { runId?: string; rootRunId?: string; status?: string; error?: string; summary?: string }

const defaults = (): FollowUpDeps => {
    const cowork = () => nodeRequire('../../stores/coworkStore.js') as Pick<FollowUpDeps, 'getPlanOfAutomationRun' | 'closeWaitingRun' | 'listWaitingRuns'>;
    return {
        getPlanOfAutomationRun: (id) => cowork().getPlanOfAutomationRun(id),
        closeWaitingRun: (id, end) => cowork().closeWaitingRun(id, end),
        listWaitingRuns: (limit, after) => cowork().listWaitingRuns(limit, after),
        getLatestRunInChain: (id) => (nodeRequire('../../stores/automationStore') as { getLatestRunInChain: FollowUpDeps['getLatestRunInChain'] }).getLatestRunInChain(id),
        getRunStepsForChain: (id) => (nodeRequire('../../stores/automationStore') as { getRunStepsForChain: FollowUpDeps['getRunStepsForChain'] }).getRunStepsForChain(id),
        createNotification: (n) => (nodeRequire('../../stores/notificationStore') as { createNotification: FollowUpDeps['createNotification'] }).createNotification(n),
        onRunEvent: (type, handler) => (nodeRequire('../runEventBus.js') as { onRunEvent: FollowUpDeps['onRunEvent'] }).onRunEvent(type, handler),
        recordDecisions: (plan, journeyId) => (nodeRequire('./planTrust.mts') as typeof import('./planTrust.mts')).recordJourneyDecisions(plan, journeyId),
    };
};

/** Statuses in which the journey is not over: it runs, or waits for a person again. */
const NOT_OVER: ReadonlySet<string> = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_form', 'awaiting_confirm']);

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

interface End { status: 'success' | 'error'; result: string | null; error: string | null }

/** How a journey ended, in the words its Cowork run keeps; null while it is not over. */
function endOf(leg: Leg): End | null {
    const status = leg.status ?? '';
    if (!status || NOT_OVER.has(status)) return null;
    if (status === 'success') return { status: 'success', result: null, error: null };
    return { status: 'error', result: null, error: text(leg.error) ?? `The plan ended as "${status}" after your decision.` };
}

/** Tell the owner how it ended: always a failure, a success only when the plan has no result step of its own. */
async function tellOwner(plan: PlanOfRun, end: End, deps: FollowUpDeps): Promise<void> {
    const ok = end.status === 'success';
    if (ok && planViewOf(plan.definition as Definition, toolLookups()).makeUp.deliver > 0) return;
    try {
        await deps.createNotification({
            userId: plan.userId, taskId: plan.scheduleId, category: NOTIFICATION.category,
            title: ok ? `${NOTIFICATION.prefix}${plan.title ?? ''}` : NOTIFICATION.failureTitle,
            message: ok ? end.result : `${plan.title ?? 'Your plan'}: ${end.error}`,
            link: ok ? NOTIFICATION.link : `/app/cowork/${plan.scheduleId}`,
        });
    } catch (e) {
        log.warn(`[Cowork] could not tell the owner how plan run ${plan.runId} ended: ${(e as Error).message}`);
    }
}

/** What the journey produced: the text of its last step that gave one (a result step's message), else null. */
async function producedBy(journeyId: string, deps: FollowUpDeps): Promise<string | null> {
    const done = (await deps.getRunStepsForChain(journeyId)).filter((r) => r.status === 'success' && r.output !== null && r.output !== undefined);
    const last = done.at(-1);
    if (!last) return null;
    const textOf = resultTextOf({ lastOutput: last.output, summary: null });
    return textOf === 'Done.' ? null : textOf;
}

/** Close the Cowork run of one journey that ended with `leg`'s status; answers whether a waiting run was closed. */
export async function closeJourney(journeyId: string, leg: Leg, deps: FollowUpDeps = defaults()): Promise<boolean> {
    const ended = endOf(leg);
    if (!ended) return false;
    // Most runs that end are no plan runs at all: ask that first (an indexed lookup), and only then read the steps.
    const plan = await deps.getPlanOfAutomationRun(journeyId);
    if (!plan) return false;
    // The run's result is what it produced, not the engine's list of its steps.
    const end = ended.status === 'success' ? { ...ended, result: (await producedBy(journeyId, deps)) ?? 'Done, after your decision.' } : ended;
    if (!(await deps.closeWaitingRun(plan.runId, end))) return false;
    await tellOwner(plan, end, deps);
    // It ended now, after its owner's decision: the items that start after this one hear it (./runEnded.mts).
    runEnded({ id: plan.scheduleId, userId: plan.userId, title: plan.title }, plan.runId);
    // The decisions count towards trust per step and recipient (./planTrust.mts); a count that fails costs nothing else.
    if (deps.recordDecisions) await deps.recordDecisions(plan, journeyId).catch((e: Error) => log.warn(`[Cowork] the decisions of plan run ${plan.runId} were not counted: ${e.message}`));
    log.info(`[Cowork] plan run ${plan.runId} closed as ${end.status} after its decision`);
    return true;
}

/** One engine event: a journey that ended closes its waiting Cowork run. */
export async function onRunEnd(event: RunEnd, deps: FollowUpDeps = defaults()): Promise<boolean> {
    const journey = event.rootRunId || event.runId;
    if (!journey) return false;
    return closeJourney(journey, { status: event.status ?? null, error: event.error ?? null, summary: event.summary ?? null }, deps);
}

export const SWEEP_LIMIT = 100;

/** Waiting runs whose journey ended unheard: read how it ended, and close them. Answers how many were closed. */
export async function sweepWaiting(deps: FollowUpDeps = defaults()): Promise<number> {
    let closed = 0;
    // Page by cursor through every waiting run: runs whose decision is still pending must not hide the later ones.
    let after: { startedAt: string; id: string } | null = null;
    for (;;) {
        const page = await deps.listWaitingRuns(SWEEP_LIMIT, after);
        for (const waiting of page) {
            const leg = await deps.getLatestRunInChain(waiting.automationRunId);
            if (leg && await closeJourney(waiting.automationRunId, leg, deps)) closed += 1;
        }
        const last = page.at(-1);
        if (page.length < SWEEP_LIMIT || !last) return closed;
        after = { startedAt: last.startedAt, id: last.id };
    }
}

const SWEEP_EVERY_MS = 5 * 60_000;
let stopping: (() => void) | null = null;

/** Listen to the engine and sweep now and then. A second start does nothing; answers whether this one started. */
export function start(deps: FollowUpDeps = defaults()): boolean {
    if (stopping) return false;
    const heard = (event: RunEnd) => {
        onRunEnd(event, deps).catch((e: Error) => log.warn(`[Cowork] following a plan run failed: ${e.message}`));
    };
    const offFinished = deps.onRunEvent('run.finished', heard);
    const offFailed = deps.onRunEvent('run.failed', heard);
    const sweep = () => { sweepWaiting(deps).catch((e: Error) => log.warn(`[Cowork] the sweep of waiting plan runs failed: ${e.message}`)); };
    const timers = [setTimeout(sweep, 60_000), setInterval(sweep, SWEEP_EVERY_MS)];
    for (const timer of timers) timer.unref?.();
    stopping = () => { offFinished(); offFailed(); for (const timer of timers) clearTimeout(timer); };
    return true;
}

/** Stop listening and sweeping (shutdown, tests). */
export function stop(): void {
    stopping?.();
    stopping = null;
}
