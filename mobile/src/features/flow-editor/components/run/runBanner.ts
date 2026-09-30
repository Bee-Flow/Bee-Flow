/**
 * The line over the flow about the last test run — what the web builder says
 * in its run banner (RunProgressBanner, the runFocus "where the run is"
 * banner) and its result drawer's header, as one phrase and a tone. Pure.
 *
 *   going     "Testing the routine… · Send the email · 2/5 · 12s"
 *   failed    "Failed at Send the email" (or the request's own error)
 *   finished  "Test run finished · 5 steps · 1.2s"
 *   waiting   "Waiting for a form at Ask for details"
 */

import { formatDuration, statusToken } from '@/features/automations';
import type { Translate } from '@/features/flow-editor/model';

import { formatElapsed, type RunFocus } from './runFocus';
import { testDurationMs, type TestRunState } from './runState';

export type RunBannerTone = 'info' | 'error' | 'success' | 'warning';

export interface RunBannerModel {
    tone: RunBannerTone;
    text: string;
    /** The step "Show" opens, when the line names one. */
    stepId: string | null;
    live: boolean;
}

function goingText(state: TestRunState, focus: RunFocus | null, t: Translate, now: number): string {
    const head = state.kind === 'step'
        ? t('mobile.flow.run.testing_step', 'Testing…')
        : t('routines.builder.act.dry_run_live', 'Testing the routine…');
    const where = focus?.label || null;
    const count = focus && focus.total > 0 && focus.done > 0 ? `${Math.min(focus.done, focus.total)}/${focus.total}` : null;
    const clock = formatElapsed(state.startedAt, now);
    return [head, where, count, clock].filter(Boolean).join(' · ');
}

function stepCount(state: TestRunState): number {
    return state.rows.filter((r) => !r.parentStepId).length;
}

function settledText(state: TestRunState, t: Translate): string {
    const n = stepCount(state);
    const steps = n === 1 ? t('routines.canvas.summary_step', '{n} step', { n }) : t('routines.canvas.summary_steps', '{n} steps', { n });
    const ms = testDurationMs(state);
    return [t('mobile.flow.run.done', 'Test run finished'), steps, ms == null ? null : formatDuration(ms)].filter(Boolean).join(' · ');
}

export function runBannerModel(
    state: TestRunState,
    focus: RunFocus | null,
    { running, t, now = Date.now() }: { running: boolean; t: Translate; now?: number },
): RunBannerModel | null {
    if (!state.kind) return null;
    if (running) return { tone: 'info', text: goingText(state, focus, t, now), stepId: focus?.stepId ?? null, live: true };
    return settledModel(state, focus, t);
}

function settledModel(state: TestRunState, focus: RunFocus | null, t: Translate): RunBannerModel {
    if (focus?.awaitingForm) {
        return { tone: 'warning', text: t('mobile.flow.run.awaiting_form', 'Waiting for a form at {step}', { step: focus.label }), stepId: focus.stepId, live: false };
    }
    if (focus?.state === 'error' && focus.stepId) {
        return { tone: 'error', text: t('mobile.flow.run.failed_at', 'Failed at {step}', { step: focus.label }), stepId: focus.stepId, live: false };
    }
    if (state.error) return { tone: 'error', text: state.error, stepId: state.kind === 'step' ? state.stepId : null, live: false };
    const failed = state.run ? statusToken(state.run.status).tone === 'error' : false;
    if (failed) return { tone: 'error', text: state.run?.error || t('mobile.flow.run.failed', 'The test run failed'), stepId: null, live: false };
    return { tone: 'success', text: settledText(state, t), stepId: null, live: false };
}
