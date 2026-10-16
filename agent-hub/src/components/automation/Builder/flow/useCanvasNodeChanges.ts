import { applyNodeChanges } from '@xyflow/react';
import { useCallback } from 'react';
import type { NodeChange } from '@xyflow/react';
import type { LiveNodeMirror } from './useLiveNodeMirror';
import type { NodePositionChange } from './useNodeDragWiring';

interface CanvasNodeChangesOptions extends Omit<LiveNodeMirror, 'nodes'> {
    editable: boolean;
    /** Writes finished drags into the definition (flow/useNodeDragWiring). */
    commitNodePositions: (changes: NodePositionChange[]) => void;
}

/** React Flow's `onNodesChange` / `onEdgesChange`, wired to the live drag mirror. */
export function useCanvasNodeChanges({
    editable, commitNodePositions, setNodes, isDraggingRef, pendingComputedRef, carrySelection,
}: CanvasNodeChangesOptions) {
    const onNodesChange = useCallback((changes: NodeChange[]) => {
        // Always mirror the position into local state so the node moves
        // with the cursor during drag. We do this regardless of
        // `editable` because applyNodeChanges also handles selection,
        // dimensions, and removal events that React Flow expects to
        // round-trip — ignoring them entirely makes the canvas feel
        // broken in subtle ways (e.g. selection ring not updating).
        setNodes(prev => applyNodeChanges(changes, prev));
        // Track drag in-flight so the computedNodes sync effect doesn't
        // snap a dragged node back when the definition reflows mid-drag.
        for (const c of changes) {
            if (c.type === 'position') {
                if (c.dragging === true) isDraggingRef.current = true;
                else if (c.dragging === false) {
                    isDraggingRef.current = false;
                    // Drain any deferred computedNodes sync now.
                    if (pendingComputedRef.current) {
                        const pending = pendingComputedRef.current;
                        pendingComputedRef.current = null;
                        carrySelection(pending);
                    }
                }
            }
        }
        if (!editable) return;
        // Persist to the definition only when the drag finishes
        // (commitNodePositions filters dragging:false changes).
        // Other change kinds carry no position; the drag wiring filters them out.
        commitNodePositions(changes as NodePositionChange[]);
    }, [editable, commitNodePositions, setNodes, isDraggingRef, pendingComputedRef, carrySelection]);

    const onEdgesChange = useCallback((_changes: unknown) => {
        // No-op: edges are derived from definition.edges. Selection state is
        // ephemeral and handled by ReactFlow; structural removals go through
        // onEdgesDelete which we wire below.
    }, []);

    return { onNodesChange, onEdgesChange };
}
