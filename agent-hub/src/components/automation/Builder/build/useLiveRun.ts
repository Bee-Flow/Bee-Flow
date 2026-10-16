import { useEffect, useMemo } from 'react';
import { computeRunFocus as computeRunFocusJs } from '../flow/runFocus';
import type { RunFocus } from '../flow/runFocus';
import type { FlowDefinition, RunStepRow } from '../flow/types';
import { useDryRunReplay as useDryRunReplayJs } from '../flow/useDryRunReplay';
import { useReducedMotion } from '../flow/useReducedMotion';

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
 * The test run as the build tab shows it: the live-run poll, the reading of
 * it the chat column shows, and the step-by-step replay on the canvas. Split
 * out of BuildTab without a change in behaviour.
 */
export default function useLiveRun({ state, pollRunProgress, flatDef }: {
    state: LiveRunState;
    pollRunProgress?: ((runId: string) => Promise<unknown> | unknown) | null;
    flatDef: FlowDefinition | null;
}) {
    // Live-run polling. While a dry-run is in flight (status='running'),
    // hit /runs/:id/steps every 750ms so the diagram's edges animate and
    // the progress banner updates as each step completes. Stops as soon
    // as the run is no longer running.
    const liveRunInFlight = state.dryRun?.status === 'running' || state.dryRun?.status === 'queued';
    const dryRunId = state.dryRun?.id;
    useEffect(() => {
        if (!liveRunInFlight || !dryRunId || typeof pollRunProgress !== 'function') return;
        let alive = true;
        const tick = async () => {
            if (!alive) return;
            await pollRunProgress(dryRunId);
        };
        const handle = setInterval(tick, 750);
        tick();
        return () => { alive = false; clearInterval(handle); };
    }, [liveRunInFlight, dryRunId, pollRunProgress]);
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
    // touched, so the live-run poll above cannot start for a replay.
    const reducedMotion = useReducedMotion();
    const { visibleSteps: replaySteps, currentStepId: replayStepId } = useDryRunReplay({
        steps: state.steps, seq: state.dryRunSeq, enabled: true, reducedMotion, definition: flatDef,
    });

    return { liveRunInFlight, liveRunFocus, replaySteps, replayStepId };
}
