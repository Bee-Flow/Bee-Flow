import { useImperativeHandle } from 'react';
import type { ForwardedRef, RefObject } from 'react';
import type { Rf, StepId } from './diagramPaneTypes';

/** What a host reaches on the canvas through its ref. */
export interface DiagramPaneHandle {
    getCenter: () => { x: number; y: number };
    focusStep: (stepId: StepId | null | undefined) => void;
}

/** DiagramPane's imperative handle. */
export function useDiagramHandle(ref: ForwardedRef<DiagramPaneHandle>, wrapperRef: RefObject<HTMLDivElement | null>, rf: Rf) {
    useImperativeHandle(ref, () => ({
        /**
         * Flow-coordinates for the current viewport center. Used by the
         * slide-in palette when the user clicks (rather than drags) an item
         * — we need a sensible drop position and the canvas center is the
         * least surprising default.
         */
        getCenter: () => {
            const bounds = wrapperRef.current?.getBoundingClientRect();
            if (!bounds) return { x: 0, y: 0 };
            const cx = bounds.left + bounds.width / 2;
            const cy = bounds.top + bounds.height / 2;
            return rf.screenToFlowPosition
                ? rf.screenToFlowPosition({ x: cx, y: cy })
                : { x: bounds.width / 2, y: bounds.height / 2 };
        },
        /**
         * Pan/zoom the viewport to center a specific node — used when the
         * user clicks a validation issue to jump to the node it's about.
         * Highlighting itself is driven by the `highlightedStepId` prop
         * (via NodeRuntimeContext), not by this method.
         */
        focusStep: (stepId) => {
            if (!stepId || !rf.fitView) return;
            rf.fitView({ nodes: [{ id: stepId }], duration: 300, maxZoom: 1, padding: 0.5 });
        },
    }), [rf, wrapperRef]);
}
