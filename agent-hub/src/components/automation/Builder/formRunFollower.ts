import { useEffect, useState } from 'react';
import { errorStatus } from '@/utils/caughtError';
import { logger } from '@/utils/logger';
import { readRunForm, readRunKind, type PendingApproval, type RunFormState } from './formRunApi';
import { runPhase } from './runs/runPhase';
import type { FormDef } from '../../forms/PublicFormRenderer.types';
import type { FormRunKind } from './formRunContract';

/**
 * The form test overlay's own follow loop: "is there something for me?"
 *
 * The canvas follows the run's steps (hooks/automationBuilder/useFollowedRun);
 * the overlay asks GET /runs/:id/form, which answers for the journey's
 * actionable leg, and turns that into one view through runPhase:
 *
 *   paused_form (with its rendered page)  → 'form'
 *   paused_approval                       → 'approval' (never an error)
 *   done / failed / cancelled             → 'done' / 'failed' / 'stopped'
 *   running                               → read again in a second
 *
 * A page stops the loop (the person answers it). An approval keeps being read
 * slowly, so a decision made elsewhere (the inbox, the canvas) moves the
 * overlay on. A run still going after the budget, or a read the server refuses
 * (4xx), becomes 'slow': "still running, follow it on the canvas or in Runs",
 * never a spinner forever (RUN-11).
 *
 * The loop runs on timers started by follow(), outside React, like the
 * canvas's tracker; useFormRunFollower only stops it on unmount.
 */

export type FollowView =
    | { kind: 'form'; runId: string; stepId: string | null; form: FormDef }
    | { kind: 'approval'; runId: string; approval: PendingApproval | null }
    | { kind: 'done' | 'failed' | 'stopped'; runId: string; ending: FormDef | null }
    | { kind: 'slow'; runId: string; reason: 'budget' | 'unreadable' }
    | { kind: 'run_kind'; runKind: FormRunKind };

export interface FollowTiming {
    /** Between two reads while the run goes. */
    intervalMs?: number;
    /** Between two reads while it waits on somebody else's decision. */
    pausedMs?: number;
    /** Reads of a running run before the overlay says "still running". */
    maxPolls?: number;
}

const DEFAULT_TIMING: Required<FollowTiming> = { intervalMs: 1000, pausedMs: 5000, maxPolls: 600 };

const END_VIEW = { done: 'done', failed: 'failed', cancelled: 'stopped' } as const;

/** The view one answer of GET /runs/:id/form gives, or null while there is nothing to show yet. */
function viewOfFormState(state: RunFormState | null | undefined, followedId: string): FollowView | null {
    if (!state?.status) return null;
    const runId = state.runId || followedId;
    const { phase } = runPhase({ status: state.status });
    if (phase === 'paused_form') return state.waiting && state.form ? { kind: 'form', runId, stepId: state.stepId ?? null, form: state.form } : null;
    if (phase === 'paused_approval') return { kind: 'approval', runId, approval: state.pendingApproval ?? null };
    if (phase === 'running') return null;
    return { kind: END_VIEW[phase], runId, ending: state.ending ?? null };
}

/** A refusal (403, 404, a 409) ends the follow; a timeout, a throttle or a 5xx is read again. */
function refused(e: unknown): boolean {
    const status = errorStatus(e);
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class FormRunFollower {
    private token = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly timing: Required<FollowTiming>;

    constructor(private readonly emit: (view: FollowView) => void, timing: FollowTiming = {}) {
        this.timing = { ...DEFAULT_TIMING, ...timing };
    }

    /** Follow `runId` from now on; replaces whatever was followed. */
    follow(runId: string): void {
        this.stop();
        const token = ++this.token;
        void this.tick(token, runId, 0);
    }

    /** An attached run: learn whether it is a dry run, a live test or production, then follow it. */
    attach(runId: string): void {
        this.follow(runId);
        readRunKind(runId)
            .then((runKind) => { if (runKind) this.emit({ kind: 'run_kind', runKind }); })
            .catch((e: unknown) => logger.debug('Without the profile the overlay shows no chip; the run is followed anyway.', e));
    }

    stop(): void {
        this.token += 1;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private later(token: number, runId: string, polls: number, ms: number): void {
        this.timer = setTimeout(() => { void this.tick(token, runId, polls); }, ms);
    }

    private async tick(token: number, runId: string, polls: number): Promise<void> {
        let state: RunFormState | null = null;
        try {
            state = await readRunForm(runId);
        } catch (e) {
            if (this.token !== token) return;
            if (refused(e)) { this.emit({ kind: 'slow', runId, reason: 'unreadable' }); return; }
            logger.debug('A transient read must not end the test; the next tick retries.', e);
        }
        if (this.token !== token) return;
        const view = viewOfFormState(state, runId);
        if (view) this.emit(view);
        if (view?.kind === 'approval') { this.later(token, view.runId, 0, this.timing.pausedMs); return; }
        if (view) return;
        if (polls + 1 >= this.timing.maxPolls) { this.emit({ kind: 'slow', runId, reason: 'budget' }); return; }
        this.later(token, runId, polls + 1, this.timing.intervalMs);
    }
}

/** One follower for the overlay's lifetime; `emit` must be stable (a reducer's dispatch). */
export function useFormRunFollower(emit: (view: FollowView) => void, timing?: FollowTiming): FormRunFollower {
    const [follower] = useState(() => new FormRunFollower(emit, timing));
    useEffect(() => () => follower.stop(), [follower]);
    return follower;
}
