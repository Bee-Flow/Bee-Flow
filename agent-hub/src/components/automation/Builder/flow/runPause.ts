import type { TranslateFn } from '@/hooks/useTranslation';
import type { RunFocus } from './runFocus';

/**
 * A run that waits (on a form page or a decision), as the canvas banner and
 * the step drawer's approval bar talk about it. The rows say WHERE it waits
 * (flow/runFocus); this says WHOSE run it is and what the person looking at
 * the canvas may do about it.
 */

/** Who a pending approval waits on (GET /runs/:id `waitingOn`, automation/pausedRunFacts.mts). */
export interface WaitingOn {
    stageName: string | null;
    seatCount: number;
}

/**
 * What the builder knows about the run the banner names, beyond its rows:
 * read off `state.dryRun` (GET /runs/:id) by build/runIdentity.ts, with the
 * actions the canvas wires (BuildCanvas).
 */
export interface RunPause {
    /** Not a production run: a test or a dry run. */
    isTest: boolean;
    /** A dry run: its writes were simulated. */
    isDry: boolean;
    /** May this person decide the approval it waits on? null when nobody said. */
    canDecide: boolean | null;
    waitingOn: WaitingOn | null;
    /** A test of a version the working copy has moved past. */
    versionBehind: boolean;
    /** "Review & decide": open the waiting step's drawer, where the approval bar is. */
    onReview?: ((stepId: string) => void) | null;
    /** "Stop this test" / "Discard": close the waiting test run (POST /runs/:id/cancel). */
    onStop?: (() => void) | null;
    /** "Restart with the current version": a new dry run that replays this run's answers. */
    onRestart?: (() => void) | null;
}

/** "Waiting for Finance (2)", "Waiting for 3 approvers", "Waiting for the approver". */
export function waitingOnText(waitingOn: WaitingOn | null | undefined, t: TranslateFn): string {
    const n = Math.max(0, Number(waitingOn?.seatCount) || 0);
    if (waitingOn?.stageName) {
        return t('automations.approval_action_bar.waiting_for_stage', 'Waiting for {stage} ({n})', { stage: waitingOn.stageName, n: String(n) });
    }
    if (n > 1) return t('automations.approval_action_bar.waiting_for_people', 'Waiting for {n} approvers', { n: String(n) });
    return t('automations.approval_action_bar.waiting_for_approver', 'Waiting for the approver');
}

/** The run waits on a form page or a decision: nothing executes, and the clock stands still. */
export function isParked(focus: Pick<RunFocus, 'state' | 'awaitingForm' | 'awaitingApproval'> | null | undefined): boolean {
    return !!focus && focus.state !== 'error' && (!!focus.awaitingForm || !!focus.awaitingApproval);
}

/**
 * The banner's bold word for a run. `pause` is null where the host knows
 * nothing about the run beyond its rows: the words then make no claim about
 * whose decision or whose form it is.
 */
export function bannerTitle(focus: RunFocus, pause: RunPause | null | undefined, t: TranslateFn): string {
    if (focus.state === 'error') return t('automations.canvas.run_step_failed', 'Step failed');
    if (focus.awaitingApproval) {
        if (!pause) return t('automations.canvas.run_waiting_decision_any', 'Waiting for a decision');
        if (pause.canDecide === false) return waitingOnText(pause.waitingOn, t);
        return pause.isTest
            ? t('automations.canvas.run_waiting_decision_test', 'Waiting for your decision (test)')
            : t('automations.canvas.run_waiting_decision', 'Waiting for your decision');
    }
    if (focus.awaitingForm) {
        // A production run waiting on a form page is a visitor's journey: the
        // page is theirs, not something to answer from here (RUN-07).
        if (pause && !pause.isTest) return t('automations.canvas.run_visitor_on_page', 'A visitor is on “{page}”', { page: focus.label });
        return t('automations.canvas.run_waiting_form_title', 'Waiting for the form');
    }
    return t('automations.canvas.run_live', 'Live run');
}

/**
 * How long the run has been going: up to now while it runs, up to the moment
 * it paused while it waits (a test parked overnight is not "14h 3m" of work),
 * up to the last render for a failure.
 */
export function bannerElapsedEnd(focus: RunFocus, now: number, ticking: boolean): number | null {
    if (isParked(focus)) {
        const paused = Date.parse(focus.pausedAt || '');
        return Number.isFinite(paused) ? paused : null;
    }
    return ticking ? now : Date.now();
}
