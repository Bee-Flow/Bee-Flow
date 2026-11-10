import type { RunIdentity } from '../flow/useFailedRunBanner';
import type { RunPause, WaitingOn } from '../flow/runPause';
import { runPhase, type RunPhaseInput } from '../runs/runPhase';

/** The part of the builder's run row the banner reads (`state.dryRun`, as GET /runs/:id answers it). */
export interface IdentifiableRun extends RunPhaseInput {
    id?: string;
    startedAt?: string | number | null;
    /** A test of a version the working copy has moved past (server: pausedRunFacts.versionBehind). */
    versionBehind?: unknown;
    /** May the reader decide the approval it waits on (pausedRunFacts.pendingApprovalFor). */
    canDecide?: unknown;
    waitingOn?: unknown;
}

/** What the canvas can do about a waiting run (BuildCanvas wires them). */
export type RunPauseActions = Pick<RunPause, 'onReview' | 'onStop' | 'onRestart'>;

function waitingOnOf(v: unknown): WaitingOn | null {
    if (!v || typeof v !== 'object') return null;
    const w = v as { stageName?: unknown; seatCount?: unknown };
    return {
        stageName: typeof w.stageName === 'string' && w.stageName ? w.stageName : null,
        seatCount: typeof w.seatCount === 'number' && Number.isFinite(w.seatCount) ? w.seatCount : 0,
    };
}

/**
 * Which run the canvas banner is about. `state.dryRun` holds the run the
 * builder follows (useFollowedRun: one started here, or my newest after a
 * reload), so the kind comes from the row the way runPhase reads it: its run
 * profile, else mode and isTest. The stub written when a test starts carries
 * none of them yet and is, by construction, a test.
 */
export function runIdentityOf(run: IdentifiableRun | null | undefined, onOpen: ((runId: string) => void) | null, actions: RunPauseActions | null = null): RunIdentity {
    const known = run?.profile?.kind != null || run?.mode != null || run?.isTest != null;
    const isTest = !known || runPhase(run).isTest;
    const startedAt = run?.startedAt == null ? null : new Date(run.startedAt).toISOString();
    const phase = runPhase(run);
    return { kind: isTest ? 'test' : 'run', id: run?.id || null, startedAt, dryFinished: phase.isDry && phase.phase === 'done', onOpen, pause: pauseOf(run, isTest, actions) };
}

/** The run's own facts about a wait (GET /runs/:id), with the canvas's actions. */
function pauseOf(run: IdentifiableRun | null | undefined, isTest: boolean, actions: RunPauseActions | null): RunPause {
    return {
        isTest,
        isDry: runPhase(run).isDry,
        canDecide: typeof run?.canDecide === 'boolean' ? run.canDecide : null,
        waitingOn: waitingOnOf(run?.waitingOn),
        versionBehind: run?.versionBehind === true,
        ...(actions || {}),
    };
}
