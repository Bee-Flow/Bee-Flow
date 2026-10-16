import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import React, { forwardRef, useMemo } from 'react';
import '@xyflow/react/dist/style.css';

import { CanvasContextMenu, DropHint } from './flow/DiagramCanvasChrome';
import DiagramCanvasFrame from './flow/DiagramCanvasFrame';
import DiagramEmptyState from './flow/DiagramEmptyState';
import { EdgeCrossingProvider } from './flow/EdgeCrossingContext';
import { edgeTypes } from './flow/edges';
import { buildLayout } from './flow/layout';
import { NODE_TYPES } from './flow/nodeTypes';
import { useBuildFilm } from './flow/useBuildFilm';
import { useCanvasEditing } from './flow/useCanvasEditing';
import { useCanvasView } from './flow/useCanvasView';
import { useDiagramHandle } from './flow/useDiagramHandle';
import { useLiveNodeMirror } from './flow/useLiveNodeMirror';
import { useNodeRuntime } from './flow/useNodeRuntime';
import { useRenderedGraph } from './flow/useRenderedGraph';
import { useRunFocus } from './flow/useRunFocus';
import useTranslation from '../../../hooks/useTranslation';

// The step-type → node-component registry lives in flow/nodeTypes.js —
// re-exported so flow/nodeDefs.test.js and every other importer keep this
// module as their entry point.
export { NODE_TYPES } from './flow/nodeTypes';

/**
 * Interactive flow diagram for the automation builder.
 *
 * Three modes, controlled by `editable` + `readOnly`:
 *   - readOnly={true}:  pan/zoom disabled. Node clicks still fire IF an
 *                       onNodeClick handler is supplied (run-replay
 *                       click-to-inspect); with no handler nothing bubbles
 *                       (static Quick & Expert thumbnails).
 *   - editable={false}: clickable nodes (Build with AI inspector), no drag.
 *   - editable={true}:  full n8n-style canvas — drag, connect handles, drop
 *                       from palette, Delete-key to remove. Position + edge
 *                       changes call `onDefinitionChange(nextDef)`; the
 *                       parent persists via the existing automation API.
 *
 * Imperative handle (forwarded via ref) exposes:
 *   - getCenter():  returns flow-coordinates for the current viewport center.
 *                   The slide-in NodePalette uses this for click-to-add when
 *                   the user didn't drop at a specific position.
 *
 * Cycle protection: `onConnect` rejects edges that would create a cycle
 * or a self-loop. The runtime validator catches it anyway, but blocking
 * at the UI prevents a broken save round-trip while the user is still
 * arranging the graph.
 */
const DiagramPane = forwardRef(function DiagramPane({
    // The canvas never draws the diagnose affordance from here: the host
    // props stop at the list documented on DiagramPaneInner below.
    onDiagnose: _notForwarded,
    // Array/object defaults are created HERE, once per host render, never in
    // DiagramPaneInner: a fresh `[]` on every inner render (each drag tick,
    // each selection change) would re-run the layout and loop forever.
    runSteps = [],
    layerSummaries = {},
    layerRefCounts = {},
    ...props
}, ref) {
    return (
        <ReactFlowProvider>
            {/* Lets each edge see where the others are drawn, so a crossing gets
                a bridge instead of an ambiguous junction. Wraps the whole pane
                rather than the canvas, so it survives a canvas remount. */}
            <EdgeCrossingProvider>
            <DiagramPaneInner
                ref={ref}
                runSteps={runSteps}
                layerSummaries={layerSummaries}
                layerRefCounts={layerRefCounts}
                {...props}
            />
            </EdgeCrossingProvider>
        </ReactFlowProvider>
    );
});

export default DiagramPane;

const DiagramPaneInner = forwardRef(function DiagramPaneInner({
    definition,
    runSteps,          // always passed by DiagramPane (default [] there)
    onNodeClick,
    onAskAssistant = null,
    onNodeExpand,      // (nodeId) — double-click: open the FULL editor
    onDefinitionChange,
    validation = null,
    readOnly = false,
    editable = false,
    structuralEditsBlocked = false, // true while SSE stream is patching the def
    onRequestAddNode,   // ({ sourceId, position }) — called when user drags an edge end into empty pane
    onRequestOpenPalette, // () — called by the empty-state CTA on a fresh draft
    onRequestAddAfter,  // (nodeId) — called when user clicks the "+" hover button on a node
    onRequestInsertOnEdge, // ({ sourceId, targetId, position }) — "+" on an edge: insert a step between two nodes
    onDropStep = null,  // (payload, { position, sourceId?, targetId?, label?, caseName? }) — a step dragged in from the ribbon
    onExecuteStep,      // (stepId) — n8n-style per-node ▶ button
    executingStepId = null,
    runInFlight = false,
    catalog = null,           // tool catalog — needed for auto-mapping on connect
    realOutputById = null,    // Map<stepId, output> (mapping/realOutputs) — real run/pinned data for auto-map + chips
    autoMapEnabled = true,    // auto-map inputs when an edge is drawn
    onAutoMapped,             // (stepId, count) — fired after a successful auto-map
    onOpenLayer,              // (layerKey) — drill into an inline flowlet's sub-canvas
    layerSummaries,           // default {} in DiagramPane; { layerKey: description } — shown on call_layer nodes
    onStepAdded,              // (payload, sourceStep|null) — usage telemetry for the smart Add-step menu
    highlightedStepId = null, // stepId briefly ringed — e.g. after a validation-issue click
    // ── expanded flowlets ────────────────────────────────────────────────
    // `definition` may be a FLAT graph (inlineFlowlets.composeInlineGraph) with
    // one or more flowlets folded in. These three describe that folding; when
    // no flowlet is expanded they are empty and every path below is the
    // ordinary single-graph one.
    sidecar = null,           // Map<prefix, entry> — what was folded in where
    shiftById = null,         // Map<id, {dx,dy}> — display-only neighbour shift
    onToggleInline = null,    // (nodeId, layerKey) — expand/collapse in place
    onExpandAllFlowlets = null, // () — open them all, for Arrange › Open flowlets
    onCollapseAllFlowlets = null, // () — fold them away, for the tightening modes
    layerRefCounts,           // default {} in DiagramPane; { layerKey: callSiteCount }
    // ── overlay zones (builder redesign) ────────────────────────────────
    flowletsOpen = false,     // the Flowlets drawer is open (south-west button state)
    onToggleFlowlets = null,  // () — toggle the Flowlets drawer; null hides the button
    flowletCount = 0,         // badge on the Flowlets button
    fatalError = null,        // north-west validation chip: builder fatal error
    aborted = null,           //   …and the builder's abort record
    onDismissFatal = null,
    onFocusStep = null,       // (stepId) — a validation record was clicked
    onAddTrigger = null,      // (payload) — the empty canvas's trigger cards
    onOpenAssistant = null,   // () — the empty canvas's Assistant button
    editingStepId = null,     // the step open in the drawer (design 1h)
    // The automation's public form page. Only ever used by the run banner, and
    // only while a run is parked on a form (design 1d, "Formulier openen").
    formUrl = null,
    onOpenFormOverlay = null, // () — open the waiting form page over the canvas
    // What the AI build is doing right now — { running, phase, startedAt,
    // lastCall, narration, todos, finalizedId, aborted, stepCount } from
    // BuildTab. Drives the choreography's phase, the ghost slot's caption, the
    // south build banner and the empty state's cue. Null outside the builder.
    buildCue = null,
    // The add-step ribbon's root element (BuildTab's ref), for the build film
    // to deal each card FROM the ribbon command that would have added it
    // (flow/useRibbonFlight.js). Null: cards reveal in place, no flight.
    ribbonRootRef = null,
    // The row a dry-run replay is revealing right now (BuildTab →
    // flow/useDryRunReplay.js). The camera centres on that card; null = no
    // replay, the camera is left alone.
    replayStepId = null,
    // Pixels of the canvas's left edge covered by a panel drawn over it (the
    // build plan). The build camera frames in what is left, so no card lands
    // behind it. 0 when nothing covers the canvas.
    cameraInsetLeft = 0,
    onDiagnose = null,        // never forwarded by DiagramPane (see above)
}, ref) {
    const { t } = useTranslation();
    const rf = useReactFlow();
    const {
        fitAroundFurniture, mountFitOptions, hasInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, absPositionOf,
        scopeAtPoint, wrapperRef, presenter, togglePresenter, runByStep, shortCanvas, legendOpen, toggleLegend,
        edgeColorMode, setEdgeColorMode, hasPiiData, issuesByStep,
    } = useCanvasView({
        rf, definition, runSteps, validation, sidecar, readOnly, structuralEditsBlocked, editingStepId, replayStepId,
    });

    const {
        nodeOpsRef, onDeleteNode, onDetachNode, onDuplicateNode, onPinNode, baseRuntimeContext,
    } = useNodeRuntime({
        definition, runSteps, runByStep, inlineTriggerIds, inlineExpandedIds, inLoopBody,
        editingStepId, editable, structuralEditsBlocked, onExecuteStep, executingStepId, runInFlight,
        onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, layerRefCounts,
        onDefinitionChange, catalog, realOutputById, autoMapEnabled, onAutoMapped,
    });
    const { runFocus, focusRunStep } = useRunFocus({ runSteps, runInFlight, definition, rf, absPositionOf });

    // The quick-add "+" only exists where structural edits are allowed.
    const onAddAfterForLayout = (editable && !structuralEditsBlocked) ? onRequestAddAfter : null;

    const { nodes: computedNodes, edges } = useMemo(
        () => buildLayout(definition, { runByStep, issuesByStep, onAddAfter: onAddAfterForLayout, onDiagnose, sidecar, shiftById, catalog }),
        [definition, runByStep, issuesByStep, onAddAfterForLayout, onDiagnose, sidecar, shiftById, catalog],
    );

    // ── Live drag mirror (flow/useLiveNodeMirror.ts) ────────────────────
    // computedNodes mirrored into local state so a drag animates; the
    // definition is only written at drag-end via commitNodePositions.
    const { nodes, setNodes, isDraggingRef, pendingComputedRef, carrySelection } = useLiveNodeMirror(computedNodes);
    const {
        reducedMotion, buildFxById, freshEdgeKeys, ghostNodes, ghostEdges, onMoveEnd, following, resumeFollow,
        flightGhosts, onMoveStartGuarded, runtimeContextValue,
    } = useBuildFilm({
        definition, computedNodes, edges, structuralEditsBlocked, buildCue, rf, wrapperRef, runInFlight,
        catalog, t, cameraInsetLeft, ribbonRootRef, replayStepId, absPositionOf, baseRuntimeContext,
    });

    useDiagramHandle(ref, wrapperRef, rf);

    // The edit interactions (flow/useCanvasEditing.ts).
    const edit = useCanvasEditing({
        editable, structuralEditsBlocked, rf, edges, definition, hasInline, sidecar, shiftById, wrapperRef,
        nodeOpsRef, onDefinitionChange, setNodes, isDraggingRef, pendingComputedRef, carrySelection,
        inlineTriggerIds, onNodeClick, onAskAssistant, readOnly, runtimeContextValue, onExecuteStep, runInFlight,
        onDuplicateNode, onDetachNode, onPinNode, togglePresenter, autoMapEnabled, catalog, realOutputById,
        onAutoMapped, inLoopBody, onRequestAddNode, onRequestInsertOnEdge, absPositionOf, onDropStep, onStepAdded,
        scopeAtPoint, onNodeExpand, onOpenLayer,
    });
    const {
        nodeDropTarget, dropHintPos, selectedIds, clearSelection, deleteSelection, onEdgeDeleteClick, onEdgeSetColor,
        onEdgeInsertClick, ctxMenu, closeCtxMenu, dropTarget,
    } = edit;

    // Edge/node decoration pipeline and the Arrange action (flow/useRenderedGraph.ts).
    const {
        allowEdgeEdits, handleArrange, nodesWithDropTarget, renderedEdges,
    } = useRenderedGraph({
        editable, structuralEditsBlocked, onDefinitionChange, isDraggingRef,
        onExpandAllFlowlets, onCollapseAllFlowlets, wrapperRef, definition, rf,
        fitCanvas: fitAroundFurniture,
        edges, onEdgeInsertClick, onEdgeDeleteClick, onEdgeSetColor,
        onNodeExpand, onNodeClick, inLoopBody, dropTarget, nodeDropTarget,
        catalog, nodes, runByStep, runInFlight, edgeColorMode,
        stepNumberById: runtimeContextValue.stepNumberById,
        buildFxById, freshEdgeKeys, ghostNodes, ghostEdges,
    });

    if (!definition || !definition.trigger) {
        // The first screen of a new automation (BFSF-327): React Flow is not mounted yet, so the
        // build cue lives here (flow/DiagramEmptyState.jsx).
        return (
            <DiagramEmptyState
                onRequestOpenPalette={onRequestOpenPalette}
                onAddTrigger={onAddTrigger}
                onOpenAssistant={onOpenAssistant}
                building={!!(structuralEditsBlocked && buildCue?.running)}
                caption={buildCue?.narration || null}
                startedAt={buildCue?.startedAt || null}
            />
        );
    }

    // The Fit button outside a build: the whole flow, clear of the furniture.
    const fitCanvasFully = () => fitAroundFurniture({ duration: 300 });
    // The one selected card is the one open in the drawer: its actions are in
    // the drawer's header, and the selection bar would repeat them in the
    // strip of canvas left above it.
    const selectionInDrawer = !!editingStepId && selectedIds.length === 1 && selectedIds[0] === editingStepId;

    return (
        <DiagramCanvasFrame
            presenter={presenter}
            runtimeContextValue={runtimeContextValue}
            wrapperRef={wrapperRef}
            editingStepId={editingStepId}
            structuralEditsBlocked={structuralEditsBlocked}
            reducedMotion={reducedMotion}
            edit={edit}
            nodeTypes={NODE_TYPES}
            edgeTypes={edgeTypes}
            nodes={nodesWithDropTarget}
            edges={renderedEdges}
            fitViewOptions={mountFitOptions}
            readOnly={readOnly}
            editable={editable}
            hasNodeClickHandler={typeof onNodeClick === 'function'}
            onMoveStart={onMoveStartGuarded}
            onMoveEnd={onMoveEnd}
            overlays={{
                definition, allowEdgeEdits, handleArrange, structuralEditsBlocked, reducedMotion, resumeFollow, fitCanvasFully,
                presenter, togglePresenter, shortCanvas, onToggleFlowlets, flowletsOpen, flowletCount, runFocus, focusRunStep,
                formUrl, onOpenFormOverlay, selectedCount: selectedIds.length, selectionInDrawer, deleteSelection, clearSelection,
                interactive: !readOnly, editable, buildCue, following, editingStepId, stepNumberById: runtimeContextValue.stepNumberById,
                fatalError, validation, aborted, onDismissFatal, onFocusStep, edgeColorMode, setEdgeColorMode, onDefinitionChange,
                hasPiiData, legendOpen, toggleLegend, typeGroupById: runtimeContextValue.typeGroupById,
            }}
            flight={{ ghosts: flightGhosts, rf, nodes: computedNodes }}
        >
            {ctxMenu && (
                <CanvasContextMenu
                    menu={ctxMenu}
                    definition={definition}
                    inlineExpandedIds={inlineExpandedIds}
                    onDuplicateNode={onDuplicateNode}
                    onDetachNode={onDetachNode}
                    onDeleteNode={onDeleteNode}
                    onExecuteStep={onExecuteStep}
                    runInFlight={runInFlight}
                    onToggleInline={onToggleInline}
                    onAskAssistant={onAskAssistant}
                    onClose={closeCtxMenu}
                />
            )}
            {nodeDropTarget && dropHintPos && (
                <DropHint kind={nodeDropTarget.kind} x={dropHintPos.x} y={dropHintPos.y} />
            )}
        </DiagramCanvasFrame>
    );
});

// newStepId, buildStepFromPayload, applyAddNode and createsCycle moved to
// ./applyAddNode.js (a pure module with no React in it) — re-exported here
// because BuilderShell, BuildTab, LoopBodyEditor and the test suites import
// them from DiagramPane.
export { buildStepFromPayload, applyAddNode, createsCycle } from './applyAddNode';

// branchFromHandle moved to flow/branchEdges.js (the shared edge-identity
// module) — re-exported here because LoopBodyEditor and older tests import it
// from DiagramPane.
export { branchFromHandle } from './flow/branchEdges';