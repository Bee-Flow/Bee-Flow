import { Background } from '@xyflow/react';
import type { ReactFlowProps } from '@xyflow/react';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import DiagramOverlays from './DiagramOverlays';
import { DiagramReactFlow } from './DiagramReactFlow';
type ReactFlowHandlers = ComponentProps<typeof DiagramReactFlow>['handlers'];
import { NodeRuntimeContext } from './NodeRuntimeContext';
import { PresenterContext } from './PresenterContext';
import RibbonFlightLayer from './RibbonFlightLayer';
import type { useCanvasEditing } from './useCanvasEditing';

export interface DiagramCanvasFrameProps {
    presenter: boolean;
    runtimeContextValue: ComponentProps<typeof NodeRuntimeContext.Provider>['value'];
    wrapperRef: RefObject<HTMLDivElement | null>;
    editingStepId: string | null;
    structuralEditsBlocked: boolean;
    reducedMotion: boolean;
    /** The edit interactions (flow/useCanvasEditing.ts): drop handlers, selection click and React Flow's handlers. */
    edit: ReactFlowHandlers & Pick<ReturnType<typeof useCanvasEditing>, 'onDrop' | 'onDragOver' | 'onDragLeave' | 'onNodeClickWithSelection'>;
    /** Passed in, not imported: the registries sit on the Studio import cycle. */
    nodeTypes: ReactFlowProps['nodeTypes'];
    edgeTypes: ReactFlowProps['edgeTypes'];
    nodes: ReactFlowProps['nodes'];
    edges: ReactFlowProps['edges'];
    fitViewOptions: ReactFlowProps['fitViewOptions'];
    readOnly: boolean;
    editable: boolean;
    hasNodeClickHandler: boolean;
    onMoveStart: ReactFlowProps['onMoveStart'];
    onMoveEnd: ReactFlowProps['onMoveEnd'];
    overlays: ComponentProps<typeof DiagramOverlays>;
    flight: ComponentProps<typeof RibbonFlightLayer>;
    /** Drawn over the canvas after the ghosts: the context menu and the drop hint. */
    children: ReactNode;
}

/**
 * The canvas inside the diagram pane: the two contexts, the wrapper that takes
 * drops, React Flow with its overlays, and the ribbon flight layer. Hook-free;
 * DiagramPane owns the state and hands it over.
 */
export default function DiagramCanvasFrame({
    presenter, runtimeContextValue, wrapperRef, editingStepId, structuralEditsBlocked, reducedMotion, edit, nodeTypes, edgeTypes, nodes,
    edges, fitViewOptions, readOnly, editable, hasNodeClickHandler, onMoveStart, onMoveEnd, overlays, flight, children,
}: DiagramCanvasFrameProps) {
    return (
        <PresenterContext.Provider value={presenter}>
        <NodeRuntimeContext.Provider value={runtimeContextValue}>
        <div
            ref={wrapperRef}
            // While a step is open in the drawer the host sets the canvas's
            // floor (BuildTab: 220px); a floor of our own would run the pane
            // under the drawer, zoom stack and minimap included.
            className={`w-full h-full relative ${editingStepId ? '' : 'min-h-[320px]'}`}
            onDrop={edit.onDrop}
            onDragOver={edit.onDragOver}
            onDragLeave={edit.onDragLeave}
            // Present while the choreography is live — a styling hook for the
            // building state, absent under reduced motion so nothing keys on it
            // when today's behaviour is what plays.
            data-building={structuralEditsBlocked && !reducedMotion ? '' : undefined}
            // Presenter mode (flow/presenterMode.js): the stylesheet's hook for
            // the bigger south bar, badges and ghost caption.
            data-presenter={presenter ? 'on' : undefined}
        >
            <DiagramReactFlow
                nodes={nodes}
                edges={edges}
                fitViewOptions={fitViewOptions}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                readOnly={readOnly}
                editable={editable}
                structuralEditsBlocked={structuralEditsBlocked}
                hasNodeClickHandler={hasNodeClickHandler}
                // Any viewport move we did not start is the presenter taking
                // the camera (flow/useBuildChoreography.js).
                onMoveStart={onMoveStart}
                onMoveEnd={onMoveEnd}
                onNodeClick={edit.onNodeClickWithSelection}
                handlers={edit}
            >
                <Background gap={16} size={1} color="var(--border-default)" />
                <DiagramOverlays {...overlays} />
            </DiagramReactFlow>

            {/* The ghosts flying from the ribbon to their slots. Portalled to
                <body> by the layer itself, but MOUNTED here so it unmounts with
                the canvas and no ghost outlives the pane it was aimed at. */}
            <RibbonFlightLayer {...flight} />
            {children}
        </div>
        </NodeRuntimeContext.Provider>
        </PresenterContext.Provider>
    );
}
