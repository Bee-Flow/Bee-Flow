import { useCallback } from 'react';
import { seedPositions } from './layout';
import { applyDeleteNodes } from './nodeOps';
import { useCanvasHotkeys } from './useCanvasHotkeys';
import { useCanvasNodeChanges } from './useCanvasNodeChanges';
import { useCanvasSelection } from './useCanvasSelection';
import { useEdgeEditCallbacks } from './useEdgeEditCallbacks';
import { useNodeContextMenu } from './useNodeContextMenu';
import { useNodeDragWiring } from './useNodeDragWiring';
import { useStepDrop } from './useStepDrop';
import type { Node } from '@xyflow/react';
import type { CanvasHotkeyOptions } from './useCanvasHotkeys';

/** Everything the canvas's edit interactions read; each hook below takes the part it needs. */
export type CanvasEditingArgs =
    Parameters<typeof useNodeDragWiring>[0]
    & Parameters<typeof useEdgeEditCallbacks>[0]
    & Parameters<typeof useStepDrop>[0]
    & Parameters<typeof useCanvasSelection>[0]
    & Omit<Parameters<typeof useCanvasNodeChanges>[0], 'commitNodePositions'>
    & Omit<CanvasHotkeyOptions, 'selectedIds'>;

/**
 * The canvas's edit interactions, in the order DiagramPane used to call them:
 * drag-to-wire, node changes, multi-select, the keyboard, connect gestures and
 * per-edge controls, delete, the right-click menu and the step drop.
 */
export function useCanvasEditing(args: CanvasEditingArgs) {
    const { editable, structuralEditsBlocked, definition, inlineTriggerIds, onDefinitionChange } = args;
    // Drag a loose node next to a connection/node to wire it up.
    const {
        nodeDropTarget, dropHintPos, onNodeDrag, onNodeDragStop, commitNodePositions,
    } = useNodeDragWiring(args);

    const { onNodesChange, onEdgesChange } = useCanvasNodeChanges({ ...args, commitNodePositions });

    const { selectedIds, onSelectionChange, onNodeClickWithSelection, clearSelection, deleteSelection } = useCanvasSelection(args);

    // ── Keyboard (flow/useCanvasHotkeys.ts) ─────────────────────────────
    // Ctrl/Cmd+J asks the assistant; R · D · U · P act on the one selected
    // step; Shift+P (or P with nothing selected) toggles presenter mode.
    useCanvasHotkeys({ ...args, selectedIds });

    // Connect gestures and per-edge controls ("+", "×", colour).
    const {
        onConnect, onConnectEnd, onEdgesDelete,
        onEdgeDeleteClick, onEdgeSetColor, onEdgeInsertClick,
    } = useEdgeEditCallbacks(args);

    // Delete via the Delete/Backspace key, the node's hover "🗑" button, or the
    // canvas context menu — all land here.
    //
    // `applyDeleteNodes` BRIDGES the graph rather than just pruning it: removing
    // a step from the middle of a flow used to drop every edge touching it,
    // silently severing the chain and stranding everything downstream as
    // unreachable roots (BFSF-319). It also keeps the primary-trigger guard —
    // the runtime requires exactly one — while letting secondary triggers
    // (definition.triggers[]) go like any other node.
    const onNodesDelete = useCallback((deleted: Node[]) => {
        if (!editable || structuralEditsBlocked) return;
        if (!deleted || deleted.length === 0) return;
        const ids = deleted.map(n => n.id).filter(id => !inlineTriggerIds.has(id));
        if (ids.length === 0) return;
        const next = applyDeleteNodes(definition, ids);
        if (next === definition) return; // nothing removable (e.g. primary trigger only)
        onDefinitionChange?.(seedPositions(next));
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange, inlineTriggerIds]);

    const { ctxMenu, closeCtxMenu, onNodeContextMenu } = useNodeContextMenu(editable ?? false, structuralEditsBlocked ?? false, definition);

    // Drag a step in from the ribbon / add-step menu, plus the double-click drill-in.
    const {
        dropTarget, onDragOver, onDragLeave, onNodeDoubleClick, onDrop,
    } = useStepDrop(args);

    return {
        nodeDropTarget, dropHintPos, onNodeDrag, onNodeDragStop, onNodesChange, onEdgesChange,
        selectedIds, onSelectionChange, onNodeClickWithSelection, clearSelection, deleteSelection,
        onConnect, onConnectEnd, onEdgesDelete, onEdgeDeleteClick, onEdgeSetColor, onEdgeInsertClick,
        onNodesDelete, ctxMenu, closeCtxMenu, onNodeContextMenu,
        dropTarget, onDragOver, onDragLeave, onNodeDoubleClick, onDrop,
    };
}
