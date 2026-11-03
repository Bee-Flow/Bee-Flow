/**
 * The one toast a builder run gets when its request comes back, picked from
 * the run's phase (runPhase.ts), never from "the request returned". A run that
 * waits on a person or stopped halfway must not read as complete.
 *
 * The waiting, stopped and cancelled sentences are the Runs tab's own
 * (runOutcome.ts runSentence), so a run reads the same in the toast and in its
 * row. Only the step-named pauses and the finished lines are new keys.
 */
import { toast } from '@/components/shared/Toast';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { RunRowData } from '@/api/queries/automation/runs';
import type { FlowDefinition, FlowStep } from '../flow/types';
import { runSentence } from './runOutcome';
import { runPhase, type RunPhaseInput } from './runPhase';

type RunToastTone = 'success' | 'info' | 'error';

export interface RunToast {
    tone: RunToastTone;
    message: string;
}

/** A run as the builder holds it after a run request (the run row fields, plus a profile). */
export type ToastRun = Partial<RunRowData> & RunPhaseInput;

export interface RunToastOptions {
    /** The label of the step the run waits on or stopped at; '' or absent = not known. */
    stepLabel?: string | null;
}

type ToastSink = Pick<typeof toast, RunToastTone>;

function oneLine(text: unknown, max = 140): string {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function finished(t: TranslateFn, isDry: boolean, isTest: boolean): string {
    if (isDry) return t('automation_testing.toast.done_dry', 'Dry run finished. Open a step to see its output.');
    if (isTest) return t('automation_testing.toast.done_test', 'Test run finished. Open a step to see its output.');
    return t('automation_testing.toast.done', 'Run finished. Open a step to see its output.');
}

function stoppedAt(t: TranslateFn, run: RunRowData, step: string): string {
    // The server's outcome already names the step and words the reason.
    if (run.outcome?.code) return runSentence(t, run);
    const cause = oneLine(run.error);
    return cause
        ? t('runs.sentence.stopped_at', 'Stopped at "{step}": {cause}', { step, cause })
        : t('runs.sentence.stopped_at_step', 'Stopped at "{step}"', { step });
}

/** Which toast a returned run gets, without showing it. */
export function runToastFor(t: TranslateFn, run: ToastRun | null | undefined, opts: RunToastOptions = {}): RunToast {
    const { phase, isDry, isTest } = runPhase(run);
    const row: RunRowData = { ...(run || {}), id: run?.id ?? '' };
    const step = oneLine(opts.stepLabel, 80);
    switch (phase) {
        case 'done':
            return { tone: 'success', message: finished(t, isDry, isTest) };
        case 'paused_approval':
            // awaiting_confirm has no step to name: the Runs tab's sentence says what it waits for.
            return {
                tone: 'info',
                message: step && row.status !== 'awaiting_confirm'
                    ? t('automation_testing.toast.waiting_decision', 'Waiting for a decision on "{step}"', { step })
                    : runSentence(t, row),
            };
        case 'paused_form':
            return {
                tone: 'info',
                message: step
                    ? t('automation_testing.toast.waiting_form', 'Waiting for the form on "{step}"', { step })
                    : runSentence(t, row),
            };
        case 'failed':
            return { tone: 'error', message: step ? stoppedAt(t, row, step) : runSentence(t, row) };
        case 'cancelled':
            return { tone: 'info', message: runSentence(t, row) };
        default:
            return { tone: 'info', message: t('runs.sentence.running', 'Still running') };
    }
}

/** Show the one toast a returned run gets; returns what it showed. */
export function runOutcomeToast(
    t: TranslateFn, run: ToastRun | null | undefined, opts: RunToastOptions = {}, sink: ToastSink = toast,
): RunToast {
    const out = runToastFor(t, run, opts);
    sink[out.tone](out.message);
    return out;
}

const PAUSED = new Set(['awaiting_form', 'awaiting_approval', 'awaiting_confirm']);

type ToastStepRow = { stepId?: string; status?: string | null; parentStepId?: string | null };
type ToastStepRun = { status?: string | null; awaitingStepId?: string | null };

/** The id of the step a run waits on (its awaitingStepId first) or failed at (the last top-level error row). */
function toastStepId(run: ToastStepRun | null | undefined, rows: ToastStepRow[]): string {
    const { phase } = runPhase(run);
    const last = (match: (r: ToastStepRow) => boolean) => [...rows].reverse().find(r => r && match(r))?.stepId || '';
    if (phase === 'paused_form' || phase === 'paused_approval') {
        return run?.awaitingStepId || last(r => PAUSED.has(String(r.status)));
    }
    if (phase === 'failed') return last(r => r.status === 'error' && !r.parentStepId);
    return '';
}

/**
 * The label of the step a returned run waits on or stopped at, looked up in
 * the definition on the canvas. '' when the step is not in it: the toast then
 * uses its stepless sentence rather than showing a raw id.
 */
export function toastStepLabel(
    def: FlowDefinition | null | undefined, run: ToastStepRun | null | undefined, steps?: unknown,
): string {
    const stepId = toastStepId(run, Array.isArray(steps) ? steps as ToastStepRow[] : []);
    if (!stepId) return '';
    const graph = [def?.trigger, ...(def?.triggers || []), ...(def?.steps || [])].filter(Boolean) as FlowStep[];
    const step = graph.find(s => s.id === stepId);
    return step ? String(step.label || step.tool || '') : '';
}
