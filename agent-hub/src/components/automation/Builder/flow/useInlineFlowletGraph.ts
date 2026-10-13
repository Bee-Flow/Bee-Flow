import { useCallback, useMemo } from 'react';
import { CONTAINER_HEADER, parseInlineId } from './inlineFlowlets';
import type { FlowNode, Rf, Sidecar, StepId } from './diagramPaneTypes';

export interface InlineFlowletGraph {
    hasInline: boolean;
    inlineExpandedIds: Set<string>;
    inlineTriggerIds: Set<StepId>;
    inLoopBody: (nodeId: StepId) => boolean;
    absPositionOf: (node: FlowNode | null | undefined) => { x: number; y: number } | null;
    scopeAtPoint: (point: { x: number; y: number } | null | undefined) => string;
}

/**
 * What DiagramPane derives from the expanded-flowlet sidecar
 * (inlineFlowlets.composeInlineGraph): which containers are open, which ids
 * are their `layer_input` triggers, which nodes sit in a loop body, and the
 * two geometry helpers (absolute position, scope under a point). With no
 * flowlet expanded every set is empty and every path is the single-graph one.
 */
export function useInlineFlowletGraph({ sidecar, rf }: { sidecar: Sidecar | null; rf: Rf }): InlineFlowletGraph {
    const hasInline = !!sidecar && sidecar.size > 0;
    const inlineExpandedIds = useMemo(() => new Set(sidecar ? sidecar.keys() : []), [sidecar]);
    const inlineTriggerIds = useMemo(
        () => new Set(sidecar ? [...sidecar.values()].map(e => e.triggerId).filter(Boolean) as StepId[] : []),
        [sidecar],
    );
    // Expanded LOOP containers, by prefix. A loop body is an ordered array with
    // no edges of its own: the chain on screen IS the order, derived on the way
    // in and read back on the way out (flow/loopBodyEdges.js). So the gestures
    // that change order all work, and the ones that would draw something the
    // runtime can't do — a free-hand connection, deleting a link — are refused
    // rather than silently undone by the next render.
    const loopPrefixes = useMemo(
        () => new Set(sidecar ? [...sidecar.values()].filter(e => e.kind === 'loop').map(e => e.prefix) : []),
        [sidecar],
    );
    const inLoopBody = useCallback(
        (nodeId: StepId) => loopPrefixes.size > 0 && loopPrefixes.has(parseInlineId(nodeId).prefix),
        [loopPrefixes],
    );

    /**
     * A node's absolute canvas position. React Flow stores a node inside an
     * expanded flowlet relative to its container, so anything that hands a
     * position OUT of this component has to add the ancestors back on.
     */
    const absPositionOf = useCallback((node: FlowNode | null | undefined) => {
        if (!node?.position) return null;
        let { x, y } = node.position;
        let parent = node.parentId;
        while (parent) {
            const pn = rf.getNode?.(parent);
            if (!pn?.position) break;
            x += pn.position.x;
            y += pn.position.y;
            parent = pn.parentId;
        }
        return { x, y };
    }, [rf]);

    /**
     * Which graph a canvas point belongs to: the innermost expanded flowlet
     * whose box contains it (its header strip excluded — dropping on the title
     * bar means "next to the flowlet", not "into it"), or '' for the canvas's
     * own graph.
     */
    const scopeAtPoint = useCallback((point: { x: number; y: number } | null | undefined) => {
        if (!hasInline || !point) return '';
        let best = '';
        for (const [prefix, entry] of sidecar!) {
            const abs = absPositionOf(rf.getNode?.(prefix));
            if (!abs) continue;
            const inside = point.x >= abs.x && point.x <= abs.x + entry.size.width
                && point.y >= abs.y + CONTAINER_HEADER && point.y <= abs.y + entry.size.height;
            if (inside && prefix.length > best.length) best = prefix;
        }
        return best;
    }, [hasInline, sidecar, rf, absPositionOf]);

    return { hasInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, absPositionOf, scopeAtPoint };
}
