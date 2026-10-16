import { useCallback, type RefObject } from 'react';
import type { computeRunFocus } from './runFocus';
import { useFailedRunBanner, type RunIdentity } from './useFailedRunBanner';
import type { DiagramDefinition, FlowNode, Rf } from './diagramPaneTypes';

interface RunFocusOptions {
    runSteps: Parameters<typeof computeRunFocus>[0] extends infer P ? P extends { runSteps?: infer R } ? R : never : never;
    runInFlight: boolean;
    definition: DiagramDefinition;
    rf: Rf;
    absPositionOf: (node: FlowNode | null | undefined) => { x: number; y: number } | null;
    /** Which run the failure banner talks about (flow/useFailedRunBanner). */
    runIdentity?: RunIdentity | null;
    /** Gets focus back when the banner is dismissed. */
    focusRef?: RefObject<HTMLElement | null> | null;
}

/**
 * Where the run is.
 *
 * Lives in ./runFocus so the reconciliation against the live graph
 * (BFSF-364 — a deleted node must not keep a "Run failed" banner alive, and
 * `done` must never exceed `total`) can be tested without mounting the
 * whole canvas. A failure is dismissible and goes when its step is edited
 * (flow/useFailedRunBanner). Here: that banner state, and the jump to the step it names.
 */
export function useRunFocus({ runSteps, runInFlight, definition, rf, absPositionOf, runIdentity = null, focusRef = null }: RunFocusOptions) {
    const { runFocus, dismiss: dismissRunBanner } = useFailedRunBanner({ runSteps, runInFlight, definition, runIdentity, focusRef });

    const focusRunStep = useCallback(() => {
        if (!runFocus?.stepId) return;
        const node = rf?.getNode?.(runFocus.stepId);
        const abs = absPositionOf(node);
        if (!abs || !node) return;
        // Keep the user's zoom — jumping the scale as well as the position is
        // disorienting when it happens mid-run.
        rf.setCenter?.(
            abs.x + (node.measured?.width ?? node.width ?? 240) / 2,
            abs.y + (node.measured?.height ?? node.height ?? 60) / 2,
            { duration: 300, zoom: rf.getZoom?.() },
        );
    }, [rf, runFocus?.stepId, absPositionOf]);

    return { runFocus, focusRunStep, dismissRunBanner };
}
