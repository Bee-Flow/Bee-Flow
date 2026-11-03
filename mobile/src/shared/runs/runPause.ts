/**
 * What the phone says about a run that waits: on whom, whether it is a test,
 * and what Stop is called. Pure; branches on runPhase(), never on a raw status.
 *
 *   approval, the caller may decide   "Waiting for your decision (test)"
 *   approval, somebody else decides   "Waiting for Finance (2)" / "Waiting for 3 approvers"
 *   approval, an older server         "Waiting for a decision" (it sends no canDecide)
 *   form page                         "Waiting for a form", with "Answer this page in
 *                                     the web builder": the phone cannot answer one
 *
 * Stop is "Discard this test run" on a test or dry run: nothing of it is kept
 * that anybody else relies on. A production run keeps "Stop this run".
 */

import type { TranslateFn } from '@/core/i18n';

import { RUN_PHASE_LABELS, runPhase, type RunPhaseInput } from './mirror/runPhase';

/** GET /runs/:id `waitingOn` (server/automation/pausedRunFacts.mts). */
export interface WaitingOn {
    stageName: string | null;
    seatCount: number;
}

/** The run facts a pause is told from: the phase inputs plus GET /runs/:id's approval facts. */
export interface RunPauseFacts extends RunPhaseInput {
    canDecide?: boolean | null;
    waitingOn?: WaitingOn | null;
}

export interface RunPause {
    kind: 'approval' | 'form';
    /** The server's canDecide; null when it did not say (an older server). */
    canDecide: boolean | null;
    isTest: boolean;
    /** The line: who or what the run waits on. */
    text: string;
    /** A second line, when there is one ("Answer this page in the web builder"). */
    hint: string | null;
    stopLabel: string;
    /** The "Test" marker's word; null on a production run. */
    testLabel: string | null;
}

function othersText(waitingOn: WaitingOn | null | undefined, t: TranslateFn): string {
    const n = Math.max(0, Number(waitingOn?.seatCount) || 0);
    if (waitingOn?.stageName) return t('automations.approval_action_bar.waiting_for_stage', 'Waiting for {stage} ({n})', { stage: waitingOn.stageName, n });
    if (n > 1) return t('automations.approval_action_bar.waiting_for_people', 'Waiting for {n} approvers', { n });
    return t('automations.approval_action_bar.waiting_for_approver', 'Waiting for the approver');
}

function approvalText({ canDecide, isTest, facts, step }: { canDecide: boolean | null; isTest: boolean; facts: RunPauseFacts; step: string | null }, t: TranslateFn): string {
    if (canDecide === true) {
        return isTest
            ? t('automations.canvas.run_waiting_decision_test', 'Waiting for your decision (test)')
            : t('automations.canvas.run_waiting_decision', 'Waiting for your decision');
    }
    if (canDecide === false) return othersText(facts.waitingOn, t);
    if (step) return t('mobile.runs.pause.decision_at', 'Waiting for a decision at {step}', { step });
    const label = RUN_PHASE_LABELS.paused_approval;
    return t(label.labelKey, label.label);
}

function formText(t: TranslateFn, step: string | null): string {
    if (step) return t('mobile.flow.run.awaiting_form', 'Waiting for a form at {step}', { step });
    const label = RUN_PHASE_LABELS.paused_form;
    return t(label.labelKey, label.label);
}

/** The pause a run is in, in words; null when it is not paused. `step` names the step it waits at. */
export function runPause(facts: RunPauseFacts | null | undefined, t: TranslateFn, { step = null }: { step?: string | null } = {}): RunPause | null {
    if (!facts) return null;
    const { phase, isTest } = runPhase(facts);
    if (phase !== 'paused_approval' && phase !== 'paused_form') return null;
    const canDecide = typeof facts.canDecide === 'boolean' ? facts.canDecide : null;
    const approval = phase === 'paused_approval';
    return {
        kind: approval ? 'approval' : 'form',
        canDecide,
        isTest,
        text: approval ? approvalText({ canDecide, isTest, facts, step }, t) : formText(t, step),
        hint: approval ? null : t('mobile.runs.pause.form_on_web', 'Answer this page in the web builder.'),
        stopLabel: isTest
            ? t('automations.runs.discard_test_run', 'Discard this test run')
            : t('automations.run_progress_banner.stop_this_run', 'Stop this run'),
        testLabel: isTest ? t('mobile.runs.test_marker', 'Test') : null,
    };
}
