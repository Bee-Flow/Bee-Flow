import { useCallback, useState } from 'react';
import { isToolNodeId, parseToolNodeId } from './aiToolNodes';
import { seedPositions } from './layout';
import { applyDeleteNodes } from './nodeOps';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { DefinitionEmitter, DiagramDefinition, FlowNode, Rf, StepId } from './diagramPaneTypes';

interface CanvasSelectionOptions {
    rf: Rf;
    editable: boolean;
    structuralEditsBlocked: boolean;
    definition: DiagramDefinition;
    /** Ids of the triggers of expanded flowlets: they belong to the flowlet, not to this graph. */
    inlineTriggerIds: Set<StepId>;
    onDefinitionChange: DefinitionEmitter;
    onNodeClick?: ((stepId: StepId) => void) | null;
}

/**
 * Multi-select.
 *
 * Everything that ACTS on a multi-selection already handles one: React
 * Flow drags every selected node together, `onNodesDelete` receives the
 * whole set, and `commitNodePositions` writes every finished move in one
 * definition update (so a group move is one undo step). What was missing
 * was the gesture and any sign that a selection existed at all.
 */
export function useCanvasSelection({
    rf, editable, structuralEditsBlocked, definition, inlineTriggerIds, onDefinitionChange, onNodeClick,
}: CanvasSelectionOptions) {
    const [selectedIds, setSelectedIds] = useState<StepId[]>([]);
    const onSelectionChange = useCallback(({ nodes: sel }: { nodes?: Array<{ id: StepId }> }) => {
        setSelectedIds((prev) => {
            const next = (sel || []).map(n => n.id);
            // React Flow re-emits on every internal change; a new array with
            // the same ids would re-render the whole canvas for nothing.
            if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev;
            return next;
        });
    }, []);

    // A modifier-click is a selection gesture, not "open this node" — without
    // this, ctrl-clicking a second node opened its editor over the canvas.
    const onNodeClickWithSelection = useCallback((evt: ReactMouseEvent | undefined, node: FlowNode) => {
        if (evt?.ctrlKey || evt?.metaKey || evt?.shiftKey) return;
        // Row labels and the build's ghost slot are furniture, not steps: the
        // ghost's own div is pointer-events-none, but React Flow's node wrapper
        // around it is not, and a click there used to surface BuildTab's
        // "editing is paused" toast for a card that does not exist.
        if (node?.data?.synthetic) return;
        // A tool chip is not a step — there is no editor for it. Clicking one
        // opens the AI step it belongs to, where its allowlist lives.
        const asTool = isToolNodeId(node.id) ? parseToolNodeId(node.id) : null;
        onNodeClick?.(asTool ? asTool.stepId : node.id);
    }, [onNodeClick]);

    const clearSelection = useCallback(() => {
        rf?.setNodes?.(ns => ns.map(n => (n.selected ? { ...n, selected: false } : n)));
    }, [rf]);

    const deleteSelection = useCallback(() => {
        if (!editable || structuralEditsBlocked || selectedIds.length === 0) return;
        const ids = selectedIds.filter(id => !inlineTriggerIds.has(id));
        if (ids.length === 0) return;
        const next = applyDeleteNodes(definition, ids);
        if (next === definition) return;
        onDefinitionChange?.(seedPositions(next));
    }, [definition, editable, structuralEditsBlocked, selectedIds, onDefinitionChange, inlineTriggerIds]);

    return { selectedIds, onSelectionChange, onNodeClickWithSelection, clearSelection, deleteSelection };
}
