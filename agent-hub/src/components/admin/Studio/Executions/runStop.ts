/**
 * Which runs the Studio run log offers to stop, and what the button says.
 *
 * A run that is running or queued stops at the next step. A run PAUSED on a
 * form page or an approval has nothing executing, but POST /runs/:id/cancel
 * closes it all the same: a form wait "without an answer", an approval by
 * withdrawing it. A waiting test (or dry) run is discarded rather than stopped,
 * and the button says so.
 */

export interface StoppableRun {
    status?: string | null;
    isTest?: boolean;
    mode?: string | null;
    /** How the run runs (GET /runs/:id); list rows and legacy rows have none. */
    profile?: { kind?: string | null } | null;
}

export function isRunningRun(run: StoppableRun | null | undefined): boolean {
    return run?.status === 'running' || run?.status === 'queued';
}

/** Paused on a form page or an approval: stoppable, though nothing is executing. */
export function isWaitingRun(run: StoppableRun | null | undefined): boolean {
    return run?.status === 'awaiting_form' || run?.status === 'awaiting_approval';
}

/** A test or a dry run. The server's profile decides when the row carries one. */
export function isTestLikeRun(run: StoppableRun | null | undefined): boolean {
    if (!run) return false;
    if (run.profile?.kind) return run.profile.kind !== 'production';
    return !!run.isTest || run.mode === 'dry_run';
}

/** Stopping this run discards a test that is waiting. */
export function stopDiscards(run: StoppableRun | null | undefined): boolean {
    return isWaitingRun(run) && isTestLikeRun(run);
}
