/**
 * What an opened task (./CoworkTaskView.tsx) says, worked out from what the server sent. Pure: no fetching, no React.
 *
 *   - how it works: the AI each time, an agent of the owner, or fixed steps;
 *   - its steps in RUN ORDER (the order of the plan's edges, server core/cowork/plan/planOrder.mts), each with its
 *     kind word (Reads, Changes, Sends to …, AI writes or decides) and its app, never a tool name; for a task the AI
 *     or an agent does, what its last run did;
 *   - what it may read, change and send;
 *   - which runs are on the go, which one is the latest result, and each run with its status word and one plain line.
 *     A run's raw error is never part of that line: the server's own plain sentence is (`plain`), or a general one.
 */
import { parseJsonText } from '@shared/expr/path.mjs';
import { appLabel, appsByEffect } from '../coworkPlanModel';
import { plainStepTitle, scriptSummary } from '../coworkOverviewModel';
import { recipientWord } from './coworkTaskSendsModel';
import type { TaskStatus } from '../coworkTaskStatus';
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
type StepSort = 'read' | 'change' | 'send' | 'ai' | 'ask';

export interface TaskStep {
    id: string;
    title: string;
    type?: string;
    script?: boolean;
    depth?: number;
    inputNames?: string[];
    description?: string | null;
    sort: StepSort;
    /** The app's name ("Outlook"), or null for a step no app does. */
    app: string | null;
    integrationId: string | null;
    helper: boolean;
    /** Changed or new since the steps were last approved. */
    changed: boolean;
    /** Who a step that sends reaches, as the plan says it ('owner', addresses, '*'); null when unknown or it sends nothing. */
    to: string | null;
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
        type: step.type,
        depth: step.depth,
        inputNames: step.inputNames,
        sort: sortOfPlanStep(step),
        app: step.app ? appLabel(step.app) : null,
        integrationId: step.app ?? null,
        helper: !!step.helper && step.type !== 'code',
        ...(step.type === 'code' ? { script: true, description: scriptSummary(step, t) } : {}),
        changed: changed.has(step.id),
        to: state.draft?.recipients?.[step.id] ?? null,
    }));
}

/** An app the fixed steps use: its id, and its name as the Steps section says it. */
export interface StepApp { id: string; label: string }

/** The apps the fixed steps use, each once, in the order the steps run. */
export function planApps(state: PlanState | null | undefined): StepApp[] {
    const view = state?.draft?.view;
    if (!view) return [];
    const apps: StepApp[] = [];
    for (const step of inRunOrder(view.steps, view.runOrder)) {
        if (step.app && !apps.some((a) => a.id === step.app)) apps.push({ id: step.app, label: appLabel(step.app) });
    }
    return apps;
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
        integrationId: tool.app ?? null,
        helper: false,
        changed: false,
        to: null,
    }));
    if (!run) return steps;
    return [...steps, { id: 'ai-result', title: t('cowork_task.steps.ai_result', 'Write the result'), sort: 'ai', app: null, integrationId: null, helper: false, changed: false, to: null }];
}

/** "Sends to you", "Sends to sam@hoekstra.example"; plain "Sends" when the plan does not say to whom. */
function sendsWord(to: string | null | undefined, t: TranslateFn): string {
    const who = recipientWord(to, t);
    return who ? t('cowork_task.steps.word.send_to', 'Sends to {who}', { who }) : t('cowork_task.steps.word.send', 'Sends');
}

/** The word under a step's title. */
export function stepWord(step: Pick<TaskStep, 'sort' | 'helper'> & { to?: string | null }, t: TranslateFn): string {
    if (step.helper) return t('cowork_task.steps.word.between', 'In-between step');
    switch (step.sort) {
        case 'ai': return t('cowork_task.steps.word.ai', 'AI writes or decides');
        case 'ask': return t('cowork_task.steps.word.ask', 'Asks you');
        case 'send': return sendsWord(step.to, t);
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
function firstLine(text: string | null | undefined): string {
    const lines = String(text ?? '').split('\n').map((raw) => raw.replace(/^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').trim());
    return lines.find((line) => /[\p{L}\p{N}]/u.test(line)) ?? '';
}

/** A stored result may be the JSON output of an AI step bound as a whole to the message. */
function resultMarkdown(text: string): string {
    const answer: unknown = parseJsonText(text)?.answer;
    return typeof answer === 'string' && answer.trim() ? answer : text;
}

export function runMarkdown(run: CoworkRun): string {
    if (runFailed(run) || !run.result?.trim()) return '';
    return resultMarkdown(run.result);
}

const WAITING: ReadonlySet<string> = new Set(['waiting', 'needs_review', 'awaiting_approval']);

/** A run in the one status vocabulary (../coworkTaskStatus.ts): Running, Needs you, Failed, Nothing to do or Done. */
export function runStatus(run: Pick<CoworkRun, 'status' | 'review' | 'producedOutput'>): TaskStatus {
    if (run.status === 'running') return 'running';
    if (WAITING.has(run.status) || (run.review && !run.review.resolution)) return 'needs';
    if (runFailed(run)) return 'failed';
    return run.producedOutput === false ? 'nothing' : 'done';
}

/** A run that is still open, in a line; null for one that is over. */
function openLine(run: CoworkRun, t: TranslateFn): string | null {
    if (run.status === 'running') return t('cowork_task.run.running', 'Running now…');
    if (run.status === 'waiting') return t('cowork_task.run.waiting', 'Waits for your decision.');
    if (run.review && !run.review.resolution) return t('cowork_task.run.review', 'Waits for your check: {reason}', { reason: firstLine(run.review.reason) });
    return null;
}

/** One plain line for a run: the server's own sentence when it has one, else what came out of it, or that it stopped. */
export function runLine(run: CoworkRun, t: TranslateFn, markdown = runMarkdown(run)): string {
    const open = openLine(run, t);
    if (open) return open;
    const plain = firstLine(run.plain);
    if (plain) return plain;
    if (run.error || runFailed(run)) return t('cowork_task.run.stopped', 'It stopped before it was done.');
    if (run.producedOutput === false) return t('cowork_task.run.nothing', 'Nothing to do this time.');
    return firstLine(markdown) || t('cowork_task.run.no_text', 'It finished without a text.');
}

/**
 * Why a run went the way it did, for its opened row: the review's reason where there is one, else the server's plain
 * sentence, else a general one. Its raw error goes under "Technical details" (./CoworkTaskRuns.tsx), never here.
 */
export function runReason(run: CoworkRun, t: TranslateFn): string {
    if (run.review?.reason) return run.review.reason;
    const plain = run.plain?.trim();
    if (plain) return plain;
    if (run.error || runFailed(run)) return t('cowork_task.run.reason_stopped', 'This run stopped before it was done. What it had already done stays done.');
    if (run.producedOutput === false) return t('cowork_task.run.reason_nothing', 'There was nothing to do this time.');
    return t('cowork_task.run.reason_done', 'Every step finished as planned.');
}
