/**
 * The line over the flow about the last test run — what the web builder says
 * in its run banner (RunProgressBanner, the runFocus "where the run is"
 * banner) and its result drawer's header, as one phrase and a tone. Pure.
 *
 *   going     "Testing the automation… · Send the email · 2/5 · 12s"
 *   failed    "Failed at Send the email" (or the request's own error)
 *   finished  "Test run finished · 5 steps · 1.2s"
 *   waiting   "Waiting for a form at Ask for details" (answer it in the web builder)
 *   deciding  "Waiting for your decision (test)", "Waiting for Finance (2)"
 *
 * A paused run carries `pause`: what Stop is called ("Discard this test run"
 * on a test), whether this person may decide, and the "Test" marker. Whether
 * the run waits comes from runPhase (@/shared/runs/runPhase) on the freshest
 * run row there is (GET /runs/:id, which also says canDecide and waitingOn),
 * never from a raw status word.
 */

import { formatDuration, statusToken } from '@/features/automations';
import type { Translate } from '@/features/flow-editor/model';
import { runPause, runPhase, type RunPause, type RunPauseFacts } from '@/shared/runs/runPhase';

import { formatElapsed, type RunFocus } from './runFocus';
import { testDurationMs, type TestRunState } from './runState';

export type RunBannerTone = 'info' | 'error' | 'success' | 'warning';

export interface RunBannerModel {
    tone: RunBannerTone;
    text: string;
    /** The step "Show" opens, when the line names one. */
    stepId: string | null;
    live: boolean;
    /** Present while the run waits on a decision or a form page. */
    pause?: RunPause;
}

/** The run facts the line reads a pause from: GET /runs/:id's row when there is one, else the test's own. */
export type BannerRun = RunPauseFacts & { status?: string | null; error?: string | null };

function goingText(state: TestRunState, focus: RunFocus | null, t: Translate, now: number): string {
    const head = state.kind === 'step'
        ? t('mobile.flow.run.testing_step', 'Testing…')
        : t('automations.builder.act.dry_run_live', 'Testing the automation…');
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
    const steps = n === 1 ? t('automations.canvas.summary_step', '{n} step', { n }) : t('automations.canvas.summary_steps', '{n} steps', { n });
    const ms = testDurationMs(state);
    return [t('mobile.flow.run.done', 'Test run finished'), steps, ms == null ? null : formatDuration(ms)].filter(Boolean).join(' · ');
}

export function runBannerModel(
    state: TestRunState,
    focus: RunFocus | null,
    { running, t, now = Date.now(), run }: { running: boolean; t: Translate; now?: number; run?: BannerRun | null },
): RunBannerModel | null {
    if (!state.kind) return null;
    if (running) return { tone: 'info', text: goingText(state, focus, t, now), stepId: focus?.stepId ?? null, live: true };
    return settledModel(state, focus, t, run ?? state.run);
}

/**
 * The run facts a pause is read from. The run row decides when there is one
 * (a pause decided elsewhere is over even if this test's rows still say
 * waiting); without one, the row the line names.
 */
function pauseFacts(focus: RunFocus | null, run: BannerRun | null): RunPauseFacts | null {
    if (run?.status) return run;
    if (focus?.awaitingApproval) return { status: 'awaiting_approval' };
    if (focus?.awaitingForm) return { status: 'awaiting_form' };
    return null;
}

function pausedModel(focus: RunFocus | null, facts: RunPauseFacts, t: Translate): RunBannerModel | null {
    const step = focus?.awaitingApproval || focus?.awaitingForm ? focus.label || null : null;
    const pause = runPause(facts, t, { step });
    if (!pause) return null;
    return { tone: 'warning', text: pause.text, stepId: step ? focus?.stepId ?? null : null, live: false, pause };
}

function settledModel(state: TestRunState, focus: RunFocus | null, t: Translate, run: BannerRun | null): RunBannerModel {
    const facts = pauseFacts(focus, run);
    const paused = facts ? pausedModel(focus, facts, t) : null;
    if (paused) return paused;
    if (focus?.state === 'error' && focus.stepId) {
        return { tone: 'error', text: t('mobile.flow.run.failed_at', 'Failed at {step}', { step: focus.label }), stepId: focus.stepId, live: false };
    }
    if (state.error) return { tone: 'error', text: state.error, stepId: state.kind === 'step' ? state.stepId : null, live: false };
    const failed = run ? statusToken(run.status).tone === 'error' : false;
    if (failed) return { tone: 'error', text: run?.error || t('mobile.flow.run.failed', 'The test run failed'), stepId: null, live: false };
    if (run && runPhase(run).phase === 'cancelled') return { tone: 'info', text: t('mobile.flow.run.stopped', 'Test run stopped'), stepId: null, live: false };
    return { tone: 'success', text: settledText(state, t), stepId: null, live: false };
}
