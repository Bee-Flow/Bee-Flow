import { useCallback, useEffect, useMemo } from 'react';
import { flowPosition } from './flow/flowOrder';
import type { FlowDefinition, FlowStep } from './flow/types';

/** Where one node sits in the run order, and what it can page to. */
export interface FlowPosition {
    /** 1-based, and 0 when the step is not part of this flow at all. */
    index: number;
    total: number;
    prevId: string | null;
    nextId: string | null;
}

// flowOrder.js is still JavaScript and annotates nothing, so its ids come back
// untyped. This states what its header describes; it goes away when that
// module becomes TypeScript.
const positionOf = flowPosition as (
    definition: FlowDefinition | null | undefined,
    stepId: string | undefined,
) => FlowPosition;

export interface NdvNavigation {
    position: FlowPosition;
    /** False at the edges of the flow, and wherever there is nowhere to send the user. */
    canNavigate: boolean;
    goPrev: () => void;
    goNext: () => void;
}

export interface UseNdvNavigationOptions {
    definition: FlowDefinition | null | undefined;
    step: FlowStep | null | undefined;
    onNavigate?: ((stepId: string) => void) | null;
    onClose?: (() => void) | null;
}

/**
 * Paging through the flow from inside the step editor: where this node sits,
 * how to reach its neighbours, and the keys that do it. Order is execution
 * order (flowOrder.js topological sort), not authoring order.
 */
export default function useNdvNavigation({ definition, step, onNavigate, onClose }: UseNdvNavigationOptions): NdvNavigation {
    // Where this node sits in the flow, and what comes either side of it. The
    // full view used to have no way out but closing and clicking another node
    // on the canvas, and nothing said whether you were at the start, the end,
    // or somewhere in between (BFSF-332).
    const position = useMemo(() => positionOf(definition, step?.id), [definition, step?.id]);
    const canNavigate = typeof onNavigate === 'function' && position.index > 0 && position.total > 1;
    const goPrev = useCallback(() => { if (position.prevId) onNavigate?.(position.prevId); }, [onNavigate, position.prevId]);
    const goNext = useCallback(() => { if (position.nextId) onNavigate?.(position.nextId); }, [onNavigate, position.nextId]);

    // Esc to close; Alt+←/→ to page through the flow. Alt-modified so the bare
    // arrows keep belonging to whichever field has focus.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
            if (!canNavigate || !e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key === 'ArrowLeft' && position.prevId) { e.preventDefault(); e.stopPropagation(); goPrev(); }
            else if (e.key === 'ArrowRight' && position.nextId) { e.preventDefault(); e.stopPropagation(); goNext(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, canNavigate, position.prevId, position.nextId, goPrev, goNext]);
    return { position, canNavigate, goPrev, goNext };
}
