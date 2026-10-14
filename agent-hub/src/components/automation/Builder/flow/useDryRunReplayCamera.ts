import { useCallback, useEffect, useRef } from 'react';
import type { FlowNode, Rf, StepId } from './diagramPaneTypes';

// The dry-run replay's camera: one 300 ms centring per revealed card, owned
// for its duration plus the same slack the choreography keeps, never below
// 80% — the LOD at which the result chip is drawn.
const REPLAY_CENTER_MS = 300;
const REPLAY_OWN_SLACK_MS = 80;
const REPLAY_MIN_ZOOM = 0.8;

type MoveStart = (ev: unknown, viewport: unknown) => void;

export interface DryRunReplayCameraOptions {
    replayStepId: StepId | null;
    following: boolean | undefined;
    rf: Rf;
    absPositionOf: (node: FlowNode | null | undefined) => { x: number; y: number } | null;
    onMoveStart: MoveStart;
}

/**
 * The dry run, replayed (flow/useDryRunReplay.js).
 *
 * BuildTab reveals the test run's rows one at a time and names the row
 * being revealed; the camera centres on that card, keeping the zoom (at
 * least 80%, so the chip is legible). Our own setCenter reaches React
 * Flow's onMoveStart like any gesture, so — the choreography's rule — the
 * move is OWNED for its duration and the guarded handler returned here lets
 * it pass; a move we did NOT start while a replay is on is the presenter
 * taking the camera, and the replay stops moving it until the next one.
 * `following === false` (the build film has already yielded) is honoured
 * for the same reason. One move per id: a re-render with the same id, or
 * `following` flipping, never re-centres.
 *
 * Returns the guarded onMoveStart handler for <ReactFlow>.
 */
export function useDryRunReplayCamera({
    replayStepId, following, rf, absPositionOf, onMoveStart,
}: DryRunReplayCameraOptions): MoveStart {
    const replayOwnUntilRef = useRef(0);
    const replayYieldedRef = useRef(false);
    const replayActiveRef = useRef(false);
    const replayCenteredRef = useRef<StepId | null>(null);
    useEffect(() => { replayActiveRef.current = replayStepId != null; }, [replayStepId]);
    useEffect(() => {
        if (replayStepId == null) {
            replayYieldedRef.current = false;
            replayCenteredRef.current = null;
            return;
        }
        if (replayCenteredRef.current === replayStepId) return;
        replayCenteredRef.current = replayStepId;
        if (replayYieldedRef.current || following === false) return;
        const node = rf?.getNode?.(replayStepId);
        const abs = absPositionOf(node);
        if (!abs || typeof rf?.setCenter !== 'function') return;
        const zoom = Math.max(Number(rf.getZoom?.()) || 1, REPLAY_MIN_ZOOM);
        replayOwnUntilRef.current = Date.now() + REPLAY_CENTER_MS + REPLAY_OWN_SLACK_MS;
        rf.setCenter(
            abs.x + (node!.measured?.width ?? node!.width ?? 240) / 2,
            abs.y + (node!.measured?.height ?? node!.height ?? 72) / 2,
            { duration: REPLAY_CENTER_MS, zoom },
        );
    }, [replayStepId, following, rf, absPositionOf]);
    return useCallback((ev: unknown, viewport: unknown) => {
        if (Date.now() < replayOwnUntilRef.current) return;
        if (replayActiveRef.current) replayYieldedRef.current = true;
        onMoveStart(ev, viewport);
    }, [onMoveStart]);
}
