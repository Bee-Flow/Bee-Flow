import { useCallback, useMemo } from 'react';
import { computeRunFocus } from './runFocus';
import type { DiagramDefinition, FlowNode, Rf } from './diagramPaneTypes';

interface RunFocusOptions {
    runSteps: Parameters<typeof computeRunFocus>[0] extends infer P ? P extends { runSteps?: infer R } ? R : never : never;
    runInFlight: boolean;
    definition: DiagramDefinition;
    rf: Rf;
    absPositionOf: (node: FlowNode | null | undefined) => { x: number; y: number } | null;
}

/**
 * Where the run is.
 *
 * Lives in ./runFocus so the reconciliation against the live graph
 * (BFSF-364 — a deleted node must not keep a "Run failed" banner alive, and
 * `done` must never exceed `total`) can be tested without mounting the
 * whole canvas. Here: the memo, and the jump to the step it names.
 */
export function useRunFocus({ runSteps, runInFlight, definition, rf, absPositionOf }: RunFocusOptions) {
    const runFocus = useMemo(
        () => computeRunFocus({ runSteps, runInFlight, definition }),
        [runSteps, runInFlight, definition],
    );

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

    return { runFocus, focusRunStep };
}
