/**
 * What an opened task (./CoworkTaskView.tsx) says, worked out from what the server sent. Pure: no fetching, no React.
 *
 *   - how it works: the AI each time, an agent of the owner, or fixed steps;
 *   - its steps in RUN ORDER (the order of the plan's edges, server core/cowork/plan/planOrder.mts), each with its
 *     kind word (Reads, Changes, Sends, AI writes or decides) and its app, never a tool name; for a task the AI or an
 *     agent does, what its last run did;
 *   - what it may read, change and send;
 *   - which runs are on the go, which one is the latest result, and each run in one plain line.
 */
import { appLabel, appsByEffect } from '../coworkPlanModel';
import { plainStepTitle } from '../coworkOverviewModel';
import type { CoworkItem, CoworkRun, CoworkRunTool } from '@/api/cowork.types';
import type { PlanEffect, PlanState, PlanStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

export type TaskMode = 'ai' | 'agent' | 'steps';

/** How a task works: a plan makes it fixed steps, else an agent of the owner, else the AI each time. */
export function taskModeOf(item: Pick<CoworkItem, 'agentId'>, plan: PlanState | null | undefined): TaskMode {
    if (plan?.automationId) return 'steps';
    return item.agentId ? 'agent' : 'ai';
}

/** What a step does, as its tile and its word show it. */
export type StepSort = 'read' | 'change' | 'send' | 'ai' | 'ask';

export interface TaskStep {
    id: string;
    title: string;
    sort: StepSort;
    /** The app's name ("Outlook"), or null for a step no app does. */
    app: string | null;
    helper: boolean;
    /** Changed or new since the steps were last approved. */
    changed: boolean;
}

const SORT_OF_EFFECT: Record<PlanEffect, StepSort> = { reads: 'read', writes: 'change', sends: 'send' };

function sortOfPlanStep(step: PlanStep): StepSort {
    if (step.kind === 'ai') return 'ai';
    if (step.kind === 'ask') return 'ask';
    if (step.kind === 'deliver') return 'send';
    return SORT_OF_EFFECT[step.effect] ?? 'read';
}

/** The steps of a plan in the order they run; a server without `runOrder` keeps the order of the definition. */
export function inRunOrder<S extends { id: string }>(steps: readonly S[], runOrder: readonly string[] | undefined): S[] {
    if (!runOrder || runOrder.length === 0) return [...steps];
    const at = new Map(runOrder.map((id, i) => [id, i]));
    const last = runOrder.length;
    return steps.map((s, i) => ({ s, i })).sort((a, b) => (at.get(a.s.id) ?? last + a.i) - (at.get(b.s.id) ?? last + b.i)).map(({ s }) => s);
}

/** The plan's steps as the task shows them: in run order, with the Changed mark while the plan differs from the approved one. */
export function planSteps(state: PlanState, t: TranslateFn): TaskStep[] {
    const view = state.draft?.view;
    if (!view) return [];
    const changed = new Set(state.approved && !state.upToDate ? (state.stepChanges ?? []).filter((c) => c.change !== 'removed').map((c) => c.id) : []);
    return inRunOrder(view.steps, view.runOrder).map((step) => ({
        id: step.id,
        title: plainStepTitle(step, t),
        sort: sortOfPlanStep(step),
        app: step.app ? appLabel(step.app) : null,
        helper: !!step.helper,
        changed: changed.has(step.id),
    }));
}

/** "Outlook: create draft" from the server, else the tool's words ("Outlook create draft"), never the bare name. */
function toolTitle(tool: CoworkRunTool, t: TranslateFn): string {
    if (tool.label) return tool.label;
    return plainStepTitle({ id: '', title: tool.name, kind: 'fixed' }, t);
}

/** What a run the AI or an agent did, as steps: each tool it used, then the AI writing the result. */
export function runSteps(run: CoworkRun | null | undefined, t: TranslateFn): TaskStep[] {
    const tools = (run?.activity?.tools ?? []).filter((tool) => !tool.internal && tool.ok > 0);
    const steps: TaskStep[] = tools.map((tool) => ({
        id: tool.name,
        title: toolTitle(tool, t),
        sort: SORT_OF_EFFECT[tool.effect ?? 'writes'],
        app: tool.app ? appLabel(tool.app) : null,
        helper: false,
        changed: false,
    }));
    if (!run) return steps;
    return [...steps, { id: 'ai-result', title: t('cowork_task.steps.ai_result', 'Write the result'), sort: 'ai', app: null, helper: false, changed: false }];
}

/** The word under a step's title. */
export function stepWord(step: Pick<TaskStep, 'sort' | 'helper'>, t: TranslateFn): string {
    if (step.helper) return t('cowork_task.steps.word.helper', 'Helper step');
    switch (step.sort) {
        case 'ai': return t('cowork_task.steps.word.ai', 'AI writes or decides');
        case 'ask': return t('cowork_task.steps.word.ask', 'Asks you');
        case 'send': return t('cowork_task.steps.word.send', 'Sends');
        case 'change': return t('cowork_task.steps.word.change', 'Changes');
        default: return t('cowork_task.steps.word.read', 'Reads');
    }
}

export interface MayDo { read: string[]; change: string[]; send: string[] }

const unique = (list: Array<string | null>): string[] => [...new Set(list.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

/** What fixed steps may read, change and send: the approved plan's permissions, else the draft's. */
export function planMayDo(state: PlanState, t: TranslateFn): MayDo {
    const permissions = state.approved?.permissions ?? state.draft?.permissions;
    const apps = appsByEffect(permissions);
    const send = [...apps.sends];
    if (permissions?.sends === 'owner') send.push(t('cowork_task.may.to_you', 'A message to you'));
    if (permissions?.sends === 'others') send.push(t('cowork_task.may.to_others', 'Messages to other people'));
    return { read: apps.reads, change: apps.writes, send };
}

/** What the AI or an agent used on its last run, per effect. */
export function runMayDo(steps: readonly TaskStep[]): MayDo {
    const of = (sort: StepSort) => unique(steps.filter((s) => s.sort === sort).map((s) => s.app ?? s.title));
    return { read: of('read'), change: of('change'), send: of('send') };
}

/** The run that is going on now, if there is one. */
export function liveRunOf(runs: readonly CoworkRun[] | undefined): CoworkRun | null {
    return runs?.find((r) => r.status === 'running') ?? null;
}

/** The newest run that is over: the latest result. */
export function latestRunOf(runs: readonly CoworkRun[] | undefined): CoworkRun | null {
    return runs?.find((r) => r.status !== 'running') ?? null;
}

const FAILED: ReadonlySet<string> = new Set(['error', 'failed', 'needs_reauth', 'timeout', 'cancelled', 'incomplete']);

export const runFailed = (run: Pick<CoworkRun, 'status'>): boolean => FAILED.has(run.status);

/** The first line of a text that says anything, without Markdown marks. */
export function firstLine(text: string | null | undefined): string {
    const lines = String(text ?? '').split('\n').map((raw) => raw.replace(/^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').trim());
    return lines.find((line) => /[\p{L}\p{N}]/u.test(line)) ?? '';
}

/** One plain line for a run: what came out of it, or what stopped it. */
export function runLine(run: CoworkRun, t: TranslateFn): string {
    if (run.status === 'running') return t('cowork_task.run.running', 'Running now…');
    if (run.status === 'waiting') return t('cowork_task.run.waiting', 'Waits for your decision.');
    if (run.review && !run.review.resolution) return t('cowork_task.run.review', 'Waits for your check: {reason}', { reason: firstLine(run.review.reason) });
    if (run.error) return firstLine(run.error) || t('cowork_task.run.failed', 'It stopped without saying why.');
    if (runFailed(run)) return t('cowork_task.run.failed', 'It stopped without saying why.');
    if (run.producedOutput === false) return t('cowork_task.run.nothing', 'Nothing to do this time.');
    return firstLine(run.result) || t('cowork_task.run.no_text', 'It finished without a text.');
}

/** Why a run went the way it did, for its opened row: the AI's own verdict or the review's reason where there is one. */
export function runReason(run: CoworkRun, t: TranslateFn): string {
    if (run.review?.reason) return run.review.reason;
    if (run.error) return run.error;
    if (runFailed(run)) return t('cowork_task.run.reason_failed', 'This run stopped before it changed or sent anything.');
    if (run.producedOutput === false) return t('cowork_task.run.reason_nothing', 'There was nothing to do this time.');
    return t('cowork_task.run.reason_done', 'Every step finished as planned.');
}
