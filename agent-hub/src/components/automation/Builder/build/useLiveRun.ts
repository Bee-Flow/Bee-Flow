import { useMemo } from 'react';
import { computeRunFocus as computeRunFocusJs } from '../flow/runFocus';
import type { RunFocus } from '../flow/runFocus';
import type { FlowDefinition, RunStepRow } from '../flow/types';
import { useDryRunReplay as useDryRunReplayJs } from '../flow/useDryRunReplay';
import { useReducedMotion } from '../flow/useReducedMotion';
import { runPhase } from '../runs/runPhase';

// runFocus.js reads a missing definition as an empty graph; its JSDoc says object.
const computeRunFocus = computeRunFocusJs as (opts: {
    runSteps?: RunStepRow[]; runInFlight?: boolean; definition: FlowDefinition | null;
}) => RunFocus | null;

// useDryRunReplay.js is JavaScript; this is the part of its contract BuildTab reads.
const useDryRunReplay = useDryRunReplayJs as (opts: {
    steps: RunStepRow[] | undefined; seq: unknown; enabled: boolean; reducedMotion: boolean; definition: FlowDefinition | null;
}) => { visibleSteps: RunStepRow[]; currentStepId: string | null };

export interface LiveRunState {
    steps?: RunStepRow[];
    dryRun?: { id?: string; status?: string } | null;
    dryRunSeq?: unknown;
}

/**
 * The test run as the build tab shows it: whether it is executing right now,
 * the reading of it the chat column shows, and the step-by-step replay on the
 * canvas.
 *
 * The run itself is followed by the run tracker (hooks/automationBuilder/
 * useFollowedRun.ts): it polls the run's status and rows by id while it runs
 * (750 ms), reads a paused run's status slowly (10 s) and settles the stub on a
 * pause or an end. That loop runs whichever tab is shown, so this hook does not
 * poll; it reads `state.dryRun` through runPhase. A paused run is not in
 * flight: ▶ Execute works again while it waits on a form or a decision.
 */
export default function useLiveRun({ state, flatDef }: {
    state: LiveRunState;
    flatDef: FlowDefinition | null;
}) {
    const liveRunInFlight = !!state.dryRun && runPhase(state.dryRun).phase === 'running';
    // The same reading of the live run the canvas banner shows (DiagramPane
    // computes its own from the same inputs), handed to the chat column so
    // the activity list can show the test as its live row instead of leaving
    // the spinner on the call before it for as long as the run takes.
    const liveRunFocus = useMemo(
        () => (liveRunInFlight ? computeRunFocus({ runSteps: state.steps, runInFlight: true, definition: flatDef }) : null),
        [liveRunInFlight, state.steps, flatDef],
    );

    // The test run replayed step by step (flow/useDryRunReplay.js): the rows
    // land at once on `state.steps`, the canvas reveals them one per 650 ms
    // and centres on the card being revealed. Only the canvas is on the
    // projector — the run panels keep the real rows. `state.dryRun` is never
    // touched, so a replay is never mistaken for a run in flight.
    const reducedMotion = useReducedMotion();
    const { visibleSteps: replaySteps, currentStepId: replayStepId } = useDryRunReplay({
        steps: state.steps, seq: state.dryRunSeq, enabled: true, reducedMotion, definition: flatDef,
    });

    return { liveRunInFlight, liveRunFocus, replaySteps, replayStepId };
}
