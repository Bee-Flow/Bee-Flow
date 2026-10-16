import React from 'react';
import NodeContextMenu from './NodeContextMenu';
import { canDeleteNode, canDuplicateNode, canDetachNode } from './nodeOps';
import type { DiagramDefinition, StepId } from './diagramPaneTypes';
import type { NodeContextMenuState } from './useNodeContextMenu';

interface CanvasContextMenuProps {
    menu: NodeContextMenuState;
    definition: DiagramDefinition;
    inlineExpandedIds: Set<string>;
    onDuplicateNode: (stepId: StepId) => void;
    onDetachNode: (stepId: StepId) => void;
    onDeleteNode: (stepId: StepId) => void;
    onExecuteStep?: ((stepId: StepId) => void) | null;
    runInFlight: boolean;
    onToggleInline?: ((stepId: StepId, layerKey: string) => void) | null;
    onAskAssistant?: ((stepId: StepId) => void) | null;
    onClose: () => void;
}

/** The right-click menu of a step, with only the entries that step allows. */
export function CanvasContextMenu({
    menu, definition, inlineExpandedIds, onDuplicateNode, onDetachNode, onDeleteNode, onExecuteStep,
    runInFlight, onToggleInline, onAskAssistant, onClose,
}: CanvasContextMenuProps) {
    // Which flowlet the right-clicked node calls, if any — drives the menu's
    // Expand/Collapse entry.
    const layerKey = (definition?.steps || []).find(s => s.id === menu.stepId && s.type === 'call_layer')?.layerKey || null;
    return (
        <NodeContextMenu
            x={menu.x}
            y={menu.y}
            canDelete={canDeleteNode(definition, menu.stepId)}
            canDuplicate={canDuplicateNode(definition, menu.stepId)}
            canDetach={canDetachNode(definition, menu.stepId)}
            onDuplicate={() => onDuplicateNode(menu.stepId)}
            onDetach={() => onDetachNode(menu.stepId)}
            onDelete={() => onDeleteNode(menu.stepId)}
            onExecute={onExecuteStep && !runInFlight ? () => onExecuteStep(menu.stepId) : null}
            onToggleInline={layerKey && onToggleInline ? () => onToggleInline(menu.stepId, layerKey) : null}
            inlineExpanded={inlineExpandedIds.has(menu.stepId)}
            onAskAssistant={onAskAssistant ? () => onAskAssistant(menu.stepId) : null}
            onClose={onClose}
        />
    );
}

/**
 * "Let go and I'll wire it up" — follows the cursor while a loose node is
 * dragged next to a connection or another node, so the highlight isn't left
 * to guesswork.
 */
export function DropHint({ kind, x, y }: { kind: string; x: number; y: number }) {
    return (
        <div
            className="absolute z-30 pointer-events-none px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-white shadow-lg whitespace-nowrap"
            style={{ left: x + 16, top: y + 16 }}
        >
            {kind === 'edge' ? 'Release to insert here' : 'Release to connect'}
        </div>
    );
}
