import { ReactFlow, Background, MarkerType } from '@xyflow/react';
import React from 'react';
import type { ReactFlowProps } from '@xyflow/react';
import type { ReactNode } from 'react';

// Stable default edge options — direction arrowhead at the target end so
// the user can read flow direction at a glance, plus the labelled-edge
// custom type that supports then/else branch chips.
const DEFAULT_EDGE_OPTIONS = {
    type: 'labelled',
    markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'var(--text-tertiary)',
        width: 14,
        height: 14,
    },
};

interface DiagramReactFlowProps {
    nodes: ReactFlowProps['nodes'];
    edges: ReactFlowProps['edges'];
    fitViewOptions: ReactFlowProps['fitViewOptions'];
    /** Passed in, not imported: the registries sit on the Studio import cycle. */
    nodeTypes: ReactFlowProps['nodeTypes'];
    edgeTypes: ReactFlowProps['edgeTypes'];
    readOnly: boolean;
    editable: boolean;
    structuralEditsBlocked: boolean;
    /**
     * Click-to-inspect is decoupled from readOnly: a caller that passes an
     * onNodeClick handler (e.g. RunExecutionView's click-to-inspect-a-run-step
     * panel) wants node clicks even though the canvas is read-only for editing.
     * Static thumbnails (Quick/Expert) pass no handler, so they stay inert.
     */
    hasNodeClickHandler: boolean;
    onMoveStart: ReactFlowProps['onMoveStart'];
    onMoveEnd: ReactFlowProps['onMoveEnd'];
    onNodeClick: ReactFlowProps['onNodeClick'];
    /** The canvas's edit handlers (flow/useCanvasEditing.ts); they only attach when editing is on. */
    handlers: Pick<ReactFlowProps, 'onSelectionChange' | 'onNodeDoubleClick' | 'onNodeDrag' | 'onNodeDragStop' | 'onNodesChange' | 'onEdgesChange' | 'onConnect' | 'onConnectEnd' | 'onEdgesDelete' | 'onNodesDelete' | 'onNodeContextMenu'>;
    children: ReactNode;
}

/**
 * The React Flow element with every behaviour flag the builder canvas sets.
 * What the canvas can do depends on three switches: `interactive` (not
 * read-only), `editable` (edits allowed) and `clickable` (a host wants node
 * clicks); the handlers only attach when editing is on.
 */
export function DiagramReactFlow({
    nodes, edges, fitViewOptions, nodeTypes, edgeTypes, readOnly, editable, structuralEditsBlocked, hasNodeClickHandler,
    onMoveStart, onMoveEnd, onNodeClick, handlers, children,
}: DiagramReactFlowProps) {
    const interactive = !readOnly;
    const allowDrag = editable && !structuralEditsBlocked;
    const allowConnect = editable && !structuralEditsBlocked;
    const clickable = hasNodeClickHandler;
    const {
        onSelectionChange, onNodeDoubleClick, onNodeDrag, onNodeDragStop, onNodesChange, onEdgesChange,
        onConnect, onConnectEnd, onEdgesDelete, onNodesDelete, onNodeContextMenu,
    } = handlers;
    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            // Any viewport move we did not start is the presenter taking
            // the camera (flow/useBuildChoreography.js).
            onMoveStart={onMoveStart}
            onMoveEnd={onMoveEnd}
            fitView
            // Was 0.18 — an 18% margin on every side of a canvas that is
            // usually far wider than it is tall. On a long left-to-right
            // flow that margin is spent where there is nothing to show,
            // and it comes straight out of the scale, which is the one
            // thing making the cards hard to read. 0.08 (FIT_PADDING) keeps
            // the graph off the edges without paying for empty space, and
            // offsets the wider ranksep in layout.js; where the furniture
            // reaches further in, the fit clears it (flow/furnitureFit.ts).
            fitViewOptions={fitViewOptions}
            // Wheel and touchpad input is useCanvasWheel's (above), which
            // catches it before React Flow does: React Flow can only make
            // the wheel zoom OR pan, not tell a touchpad from a mouse.
            // zoomOnPinch stays for touchscreens' two-finger pinch.
            zoomOnScroll={false}
            panOnScroll={false}
            zoomOnPinch={interactive}
            // Editable canvas reserves double-click for flowlet drill-in;
            // zooming on the same gesture would fight the navigation.
            zoomOnDoubleClick={interactive && !editable}
            proOptions={{ hideAttribution: true }}
            // Multi-select, on the gesture every node editor uses: drag on
            // empty canvas draws a selection box. Panning moves to the
            // middle mouse button and to Space+drag (React Flow's default
            // pan-activation key) — the same trade Figma, Miro and n8n
            // make, because in a canvas you build on you reach for
            // "select these" far more often than "shift the viewport".
            // Two fingers on a touchpad pan too, and a mouse wheel zooms.
            //
            // Ctrl/Cmd+click adds or removes a single node. Dragging any
            // selected node moves the whole selection and Delete removes
            // all of it — both fall out of React Flow once a selection
            // exists, since onNodesDelete and commitNodePositions already
            // take arrays.
            panOnDrag={interactive ? [1] : false}
            selectionOnDrag={interactive}
            // Selection must NOT lift a note out of its background layer
            // (BFSF-479): with the default elevation a selected note would
            // pop +1000 over the nodes and connectors it is supposed to sit
            // beneath. useRenderedGraph re-applies the same lift to every
            // selected non-note node, so cards keep their pop-to-front.
            elevateNodesOnSelect={false}
            selectionKeyCode="Shift"
            multiSelectionKeyCode={['Meta', 'Control']}
            selectNodesOnDrag={false}
            onSelectionChange={editable ? onSelectionChange : undefined}
            onNodeClick={clickable ? onNodeClick : undefined}
            onNodeDoubleClick={interactive ? onNodeDoubleClick : undefined}
            nodesDraggable={allowDrag}
            nodesConnectable={allowConnect}
            elementsSelectable={interactive || clickable}
            onNodeDrag={editable ? onNodeDrag : undefined}
            onNodeDragStop={editable ? onNodeDragStop : undefined}
            onNodesChange={editable ? onNodesChange : undefined}
            onEdgesChange={editable ? onEdgesChange : undefined}
            onConnect={editable ? onConnect : undefined}
            onConnectEnd={editable ? onConnectEnd : undefined}
            onEdgesDelete={editable ? onEdgesDelete : undefined}
            onNodesDelete={editable ? onNodesDelete : undefined}
            onNodeContextMenu={editable ? onNodeContextMenu : undefined}
            deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        >
            {children}
        </ReactFlow>
    );
}
