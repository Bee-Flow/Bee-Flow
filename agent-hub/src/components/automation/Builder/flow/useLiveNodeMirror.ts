import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { FlowNode } from './diagramPaneTypes';

export interface LiveNodeMirror {
    nodes: FlowNode[];
    setNodes: Dispatch<SetStateAction<FlowNode[]>>;
    isDraggingRef: MutableRefObject<boolean>;
    pendingComputedRef: MutableRefObject<FlowNode[] | null>;
    carrySelection: (next: FlowNode[]) => void;
}

/**
 * Live drag mirror.
 *
 * React Flow is in controlled mode — `nodes` is the source of truth
 * and it does NOT animate drags by itself. If we keep using the
 * computed-from-definition nodes directly, the visual stays frozen
 * while the user drags (definition only updates on drag-end). So we
 * mirror computedNodes into local state and apply React Flow's
 * position changes on every onNodesChange tick. The definition is
 * still only written at drag-end via commitNodePositions, so we
 * don't thrash buildLayout / the debounced save round-trip.
 */
export function useLiveNodeMirror(computedNodes: FlowNode[]): LiveNodeMirror {
    const [nodes, setNodes] = useState<FlowNode[]>(computedNodes);
    // Track whether ReactFlow is currently dragging a node. If `definition`
    // updates mid-drag (e.g. an autosave round-trip rewrites positions),
    // unconditional sync would snap the dragged node back to the persisted
    // position. We sync immediately on a non-drag definition change, and
    // defer the sync to drag-end otherwise.
    const isDraggingRef = useRef(false);
    const pendingComputedRef = useRef<FlowNode[] | null>(null);
    // `buildLayout` rebuilds nodes from the definition, and those fresh objects
    // carry no `selected` flag — so every re-layout (a run tick, a validation
    // pass, an autosave round-trip) silently dropped the user's selection and
    // multi-select looked broken. Selection is view state, not document state:
    // carry it across the sync.
    const carrySelection = useCallback((next: FlowNode[]) => {
        setNodes((prev) => {
            const selected = new Set(prev.filter(n => n.selected).map(n => n.id));
            if (selected.size === 0) return next;
            return next.map(n => (selected.has(n.id) ? { ...n, selected: true } : n));
        });
    }, []);
    useEffect(() => {
        if (isDraggingRef.current) {
            pendingComputedRef.current = computedNodes;
            return;
        }
        pendingComputedRef.current = null;
        carrySelection(computedNodes);
    }, [computedNodes, carrySelection]);
    return { nodes, setNodes, isDraggingRef, pendingComputedRef, carrySelection };
}
