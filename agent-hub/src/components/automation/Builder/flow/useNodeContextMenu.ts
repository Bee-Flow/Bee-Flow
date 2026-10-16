import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { isToolNodeId } from './aiToolNodes';
import type { DiagramDefinition, FlowNode, StepId } from './diagramPaneTypes';

export interface NodeContextMenuState {
    stepId: StepId;
    x: number;
    y: number;
}

/**
 * Right-click a node → the delete/duplicate menu. Anchored in VIEWPORT
 * coordinates because the menu portals to document.body, outside the React
 * Flow transform.
 */
export function useNodeContextMenu(editable: boolean, structuralEditsBlocked: boolean, definition: DiagramDefinition) {
    const [ctxMenu, setCtxMenu] = useState<NodeContextMenuState | null>(null);
    const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
    const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: FlowNode) => {
        if (!editable || structuralEditsBlocked || !node?.id) return;
        // The step menu (run / duplicate / disconnect / delete) has no meaning
        // for a tool chip — every entry would act on an id no step has.
        if (isToolNodeId(node.id)) return;
        event.preventDefault();
        setCtxMenu({ stepId: node.id, x: event.clientX, y: event.clientY });
    }, [editable, structuralEditsBlocked]);
    // A pan/zoom would leave the menu floating over the wrong node.
    useEffect(() => { if (ctxMenu) closeCtxMenu();   }, [definition]);
    return { ctxMenu, closeCtxMenu, onNodeContextMenu };
}
