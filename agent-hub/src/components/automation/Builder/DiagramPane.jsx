import { ReactFlow, ReactFlowProvider, Background, useReactFlow, useStore, useStoreApi, MarkerType, applyNodeChanges } from '@xyflow/react';
import React, { forwardRef, useMemo, useCallback, useRef, useState, useEffect, useImperativeHandle } from 'react';
import '@xyflow/react/dist/style.css';

import { NodeRuntimeContext } from './flow/NodeRuntimeContext';
import { PresenterContext } from './flow/PresenterContext';
import { isToolNodeId, parseToolNodeId } from './flow/aiToolNodes';
import DiagramEmptyState from './flow/DiagramEmptyState';
import DiagramOverlays from './flow/DiagramOverlays';
import { EdgeCrossingProvider } from './flow/EdgeCrossingContext';
import { edgeTypes } from './flow/edges';
import { buildLayout, seedPositions } from './flow/layout';
import { spotlightKeysFor } from './flow/ghostDraft';
import useTranslation from '../../../hooks/useTranslation';
import { buildIssuesByStep } from './flow/matchValidationToStep';
import NodeContextMenu from './flow/NodeContextMenu';
import { applyDeleteNodes, canDeleteNode, canDuplicateNode, canDetachNode } from './flow/nodeOps';
import { NODE_TYPES } from './flow/nodeTypes';
import RibbonFlightLayer from './flow/RibbonFlightLayer';
import { buildRuntimeContext } from './flow/buildRuntimeContext';
import { computeRunFocus } from './flow/runFocus';
import { effectiveRunByStep } from './flow/runStatus';
import { useBuildChoreography } from './flow/useBuildChoreography';
import { useCanvasHotkeys } from './flow/useCanvasHotkeys';
import { useCanvasWheel } from './flow/useCanvasWheel';
import { useDryRunReplayCamera } from './flow/useDryRunReplayCamera';
import { useEdgeColorMode } from './flow/useEdgeColorMode';
import { useEdgeEditCallbacks } from './flow/useEdgeEditCallbacks';
import { useFurnitureFit } from './flow/useFurnitureFit';
import { useInlineFlowletGraph } from './flow/useInlineFlowletGraph';
import { useLegendPreference } from './flow/useLegendPreference';
import { useLiveNodeMirror } from './flow/useLiveNodeMirror';
import { useNodeDragWiring } from './flow/useNodeDragWiring';
import { useNodeOps } from './flow/useNodeOps';
import { selectMeasuredIds, useOpeningFit } from './flow/useOpeningFit';
import { usePresenterToggle } from './flow/usePresenterToggle';
import { useReducedMotion } from './flow/useReducedMotion';
import { useRenderedGraph } from './flow/useRenderedGraph';
import { useRibbonFlight, FLIGHT_TOTAL_MS } from './flow/useRibbonFlight';
import { useRibbonSpotlight } from './flow/useRibbonSpotlight';
import { useStepDrop } from './flow/useStepDrop';

// The step-type → node-component registry lives in flow/nodeTypes.js —
// re-exported so flow/nodeDefs.test.js and every other importer keep this
// module as their entry point.
export { NODE_TYPES } from './flow/nodeTypes';

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

// Below this pane height the full furniture (a 182px zoom stack under the
// north chips, a 96px minimap under the lines lens) no longer fits with room
// to breathe; the pane keeps its short set (see `shortCanvas`).
const SHORT_CANVAS_PX = 420;

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
    // The canvas's own fits (mount, Fit, Arrange) keep the cards clear of the
    // zoom stack, minimap, legend and chips; the build film frames its own.
    const { fit: fitAroundFurniture, mountOptions: mountFitOptions } = useFurnitureFit();
    // React Flow's mount fit frames the first cards it measures; a builder
    // opened by navigation can hydrate its real definition a moment later.
    // Until the person does anything, each new set of cards is framed again
    // (flow/useOpeningFit.ts) — never while the film, a replay or the drawer
    // owns the camera.
    const measuredKey = useStore(selectMeasuredIds);
    useOpeningFit({
        measuredKey,
        fit: fitAroundFurniture,
        enabled: !structuralEditsBlocked && !editingStepId && replayStepId == null,
    });
    // Expanded flowlets and loops (flow/useInlineFlowletGraph.ts): what is
    // open, which ids are their triggers, and the position helpers.
    const {
        hasInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, absPositionOf, scopeAtPoint,
    } = useInlineFlowletGraph({ sidecar, rf });
    const wrapperRef = useRef(null);

    // Wheel, touchpad and pinch (flow/useCanvasWheel.ts): two fingers pan,
    // a pinch zooms around the fingers, a mouse wheel zooms as it always did.
    // Needs the wrapper, so it waits for a trigger (the empty state has none).
    const rfStore = useStoreApi();
    useCanvasWheel({ wrapperRef, rf, store: rfStore, enabled: !readOnly && !!definition?.trigger });

    // ── Presenter mode (flow/usePresenterToggle.ts) ──────────────────────
    // Bigger text for a projector; toggled from the zoom stack, Shift+P, or
    // P with nothing selected.
    const [presenter, togglePresenter] = usePresenterToggle();
    // Clicking a node opens its focused Node Detail View (NDV) — owned by the
    // parent (BuilderShell). The canvas itself no longer renders any
    // node-anchored panels.

    // Primary run rows + synthetic 'pinned' stubs for pinned nodes without a
    // run row — so a pin alone still yields edge chips and node status (e.g.
    // after a reload, when in-memory run state is gone but pins persist).
    const runByStep = useMemo(() => effectiveRunByStep(definition, runSteps), [definition, runSteps]);

    // The legend (north-east) — a per-user view preference like the
    // line-colour lens below; until the user picks, it starts closed on a
    // laptop-sized canvas (flow/useLegendPreference.ts).
    // A short canvas (the step drawer open on a laptop screen leaves a strip
    // of 220-300px) keeps only the furniture that serves the step being
    // edited: the zoom stack lies down as one row, the validation chip and
    // the south bar stay, and the minimap, Flowlets, Arrange, the Files tip,
    // the editing chip (its step number and keys are in the drawer's own
    // header), the lines lens and the legend wait until the canvas has room
    // again. The legend's stored preference is left alone.
    // 0 = not measured yet (tests, first frame): the full set.
    const paneHeight = useStore((s) => s.height);
    const shortCanvas = paneHeight > 0 && paneHeight < SHORT_CANVAS_PX;
    const paneWidth = useStore((s) => s.width);
    const [legendOpen, toggleLegend] = useLegendPreference(paneWidth, paneHeight);
    // "Colour lines by" (flow/useEdgeColorMode.ts) — a per-user presentational lens (never part of the
    // definition: it would pollute version diffs for zero shared value).
    // 'branches' by default: automatic case colours only touch case edges,
    // and manual colours render in every mode.
    const [edgeColorMode, setEdgeColorMode] = useEdgeColorMode();
    // The PII option only means something once a loaded run step carries a
    // pii summary (builder test-runs with the Privacy Shield applied to
    // automations) — offered disabled with an explanatory tooltip until then.
    const hasPiiData = useMemo(() => {
        for (const r of runByStep.values()) if (r?.piiSummary) return true;
        return false;
    }, [runByStep]);

    const issuesByStep = useMemo(
        () => buildIssuesByStep(validation, definition, sidecar),
        [validation, definition, sidecar],
    );

    // Per-node delete / duplicate / detach / patch / pin (flow/useNodeOps.ts).
    // Reached from the node's hover chrome, the canvas context menu, and the
    // node detail view (BFSF-319); stable identities, inputs read through a
    // ref. Declared ABOVE runtimeContextValue because that memo publishes
    // them to every node component.
    const {
        nodeOpsRef, onDeleteNode, onDetachNode, onDuplicateNode, onPatchStep, onPinNode,
    } = useNodeOps(
        { definition, editable, structuralEditsBlocked, onDefinitionChange, catalog, realOutputById, autoMapEnabled, onAutoMapped, inlineTriggerIds },
        runByStep,
    );

    // Derive runtime context (flow/buildRuntimeContext.ts): which steps are
    // pinned / disabled / mid-run, card identity and node actions. The
    // build-choreography flags join it further down (`runtimeContextValue`),
    // once the hook that owns them has run — they need the laid-out nodes
    // this memo runs before.
    const baseRuntimeContext = useMemo(() => buildRuntimeContext({
        definition, runSteps, runByStep, inlineTriggerIds, inlineExpandedIds, inLoopBody,
        editingStepId, editable, structuralEditsBlocked, onExecuteStep, executingStepId, runInFlight,
        onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, layerRefCounts,
        onPinNode, onDeleteNode, onDuplicateNode, onDetachNode, onPatchStep,
    }), [definition, runSteps, runByStep, onExecuteStep, executingStepId, runInFlight, editable, structuralEditsBlocked, onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, layerRefCounts, onPatchStep, onPinNode, editingStepId, onDeleteNode, onDuplicateNode, onDetachNode]);
    // ── Where the run is ─────────────────────────────────────────────────
    //
    // Lives in ./flow/runFocus so the reconciliation against the live graph
    // (BFSF-364 — a deleted node must not keep a "Run failed" banner alive, and
    // `done` must never exceed `total`) can be tested without mounting the
    // whole canvas.
    const runFocus = useMemo(
        () => computeRunFocus({ runSteps, runInFlight, definition }),
        [runSteps, runInFlight, definition],
    );

    const focusRunStep = useCallback(() => {
        if (!runFocus?.stepId) return;
        const node = rf?.getNode?.(runFocus.stepId);
        const abs = absPositionOf(node);
        if (!abs) return;
        // Keep the user's zoom — jumping the scale as well as the position is
        // disorienting when it happens mid-run.
        rf.setCenter?.(
            abs.x + (node.measured?.width ?? node.width ?? 240) / 2,
            abs.y + (node.measured?.height ?? node.height ?? 60) / 2,
            { duration: 300, zoom: rf.getZoom?.() },
        );
    }, [rf, runFocus?.stepId, absPositionOf]);

    // Quick-add "+" callback only fires in editable mode — there's no
    // point rendering the button on a read-only canvas where structural
    // edits are blocked.
    const onAddAfterForLayout = (editable && !structuralEditsBlocked) ? onRequestAddAfter : null;

    const { nodes: computedNodes, edges } = useMemo(
        () => buildLayout(definition, { runByStep, issuesByStep, onAddAfter: onAddAfterForLayout, onDiagnose, sidecar, shiftById, catalog }),
        [definition, runByStep, issuesByStep, onAddAfterForLayout, onDiagnose, sidecar, shiftById, catalog],
    );

    // ── Live drag mirror (flow/useLiveNodeMirror.ts) ────────────────────
    // computedNodes mirrored into local state so a drag animates; the
    // definition is only written at drag-end via commitNodePositions.
    const { nodes, setNodes, isDraggingRef, pendingComputedRef, carrySelection } = useLiveNodeMirror(computedNodes);
    // ── The build as a film ─────────────────────────────────────────────
    // While the AI is writing the graph: each draft is diffed into reveal
    // flags for the cards and edges it added or edited, one frontier card
    // carries the --accent outline, a ghost slot ahead of it shows what the
    // model is working on, and the camera follows — pushing in on an arrival
    // that landed off-screen, pulling wide at chapter breaks, and yielding for
    // good the moment the presenter touches the viewport. All of it lives in
    // flow/useBuildChoreography.js; with the OS "reduce motion" setting on it
    // reproduces the earlier count-keyed fitView and issues no flags.
    const reducedMotion = useReducedMotion();
    // The order the model itself dealt a batch in (`builder_add_steps` lists
    // its `added` entries in writing order; BuildTab keeps them on the cue).
    // Keyed on the call, not the cue: the cue is rebuilt per narration phrase.
    const lastCallAdded = buildCue?.lastCall?.added;
    const orderHint = useMemo(
        () => (Array.isArray(lastCallAdded) ? lastCallAdded.map(a => a?.id).filter(id => id != null) : null),
        [lastCallAdded],
    );
    // With a ribbon on screen every card's reveal waits for its ghost to land
    // (departure + FLIGHT_TOTAL_MS); without one — a read-only canvas, the
    // trigger-picker state — the cards reveal at their departure as before.
    const hasRibbon = !!ribbonRootRef?.current;
    const {
        buildFxById, frontierId, freshEdgeKeys, ghostNodes, ghostEdges,
        onMoveStart, onMoveEnd, following, resumeFollow,
        revealQueue, revealHead, active: buildActive, ghostDraft,
    } = useBuildChoreography({
        definition, computedNodes, edges, structuralEditsBlocked, buildCue, rf, wrapperRef, reducedMotion, runInFlight,
        orderHint, flightMs: hasRibbon ? FLIGHT_TOTAL_MS : 0, catalog, t, cameraInsetLeft,
    });
    const { ghosts: flightGhosts } = useRibbonFlight({
        queue: revealQueue, head: revealHead, definition, catalog, rf, ribbonRootRef, reducedMotion,
        enabled: buildActive && hasRibbon,
    });

    // ── The dry run, replayed (flow/useDryRunReplayCamera.ts) ───────────
    // The camera centres on the card a replay reveals; a move we did not
    // start while a replay is on hands the camera back to the presenter.
    const onMoveStartGuarded = useDryRunReplayCamera({ replayStepId, following, rf, absPositionOf, onMoveStart });
    // While the model is TYPING an app step (or inspecting an app), the tile
    // it is drawn from wears a steady spotlight — the eye is on the ribbon
    // before the pick ring flashes there at the card's departure.
    const spotKeys = useMemo(() => spotlightKeysFor(ghostDraft, catalog), [ghostDraft, catalog]);
    useRibbonSpotlight({
        ribbonRootRef, keys: spotKeys,
        enabled: buildActive && hasRibbon && !!buildCue?.running,
    });

    // The flags change once per tool call, never per streamed token, so
    // folding them into the node context re-renders the cards exactly when a
    // card has something new to show.
    const runtimeContextValue = useMemo(
        () => ({ ...baseRuntimeContext, buildFxById, frontierId }),
        [baseRuntimeContext, buildFxById, frontierId],
    );

    useImperativeHandle(ref, () => ({
        /**
         * Flow-coordinates for the current viewport center. Used by the
         * slide-in palette when the user clicks (rather than drags) an item
         * — we need a sensible drop position and the canvas center is the
         * least surprising default.
         */
        getCenter: () => {
            const bounds = wrapperRef.current?.getBoundingClientRect();
            if (!bounds) return { x: 0, y: 0 };
            const cx = bounds.left + bounds.width / 2;
            const cy = bounds.top + bounds.height / 2;
            return rf.screenToFlowPosition
                ? rf.screenToFlowPosition({ x: cx, y: cy })
                : { x: bounds.width / 2, y: bounds.height / 2 };
        },
        /**
         * Pan/zoom the viewport to center a specific node — used when the
         * user clicks a validation issue to jump to the node it's about.
         * Highlighting itself is driven by the `highlightedStepId` prop
         * (via NodeRuntimeContext), not by this method.
         */
        focusStep: (stepId) => {
            if (!stepId || !rf.fitView) return;
            rf.fitView({ nodes: [{ id: stepId }], duration: 300, maxZoom: 1, padding: 0.5 });
        },
    }), [rf]);

    // ── Edit handlers ───────────────────────────────────────────────────

    // Drag a loose node next to a connection/node to wire it up — state and
    // callbacks live in flow/useNodeDragWiring.js. Called from the same hook
    // position as before, so hook order and state ownership are unchanged.
    const {
        nodeDropTarget, dropHintPos, onNodeDrag, onNodeDragStop, commitNodePositions,
    } = useNodeDragWiring({
        editable, structuralEditsBlocked, rf, edges, definition,
        hasInline, sidecar, shiftById, wrapperRef, nodeOpsRef, onDefinitionChange,
    });

    const onNodesChange = useCallback((changes) => {
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
        commitNodePositions(changes);
    }, [editable, commitNodePositions, setNodes, isDraggingRef, pendingComputedRef, carrySelection]);

    const onEdgesChange = useCallback((_changes) => {
        // No-op: edges are derived from definition.edges. Selection state is
        // ephemeral and handled by ReactFlow; structural removals go through
        // onEdgesDelete which we wire below.
    }, []);

    // ── Multi-select ─────────────────────────────────────────────────────
    //
    // Everything that ACTS on a multi-selection already handles one: React
    // Flow drags every selected node together, `onNodesDelete` receives the
    // whole set, and `commitNodePositions` writes every finished move in one
    // definition update (so a group move is one undo step). What was missing
    // was the gesture and any sign that a selection existed at all.
    const [selectedIds, setSelectedIds] = useState([]);
    const onSelectionChange = useCallback(({ nodes: sel }) => {
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
    const onNodeClickWithSelection = useCallback((evt, node) => {
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

    // ── Keyboard (flow/useCanvasHotkeys.ts) ─────────────────────────────
    // Ctrl/Cmd+J asks the assistant; R · D · U · P act on the one selected
    // step; Shift+P (or P with nothing selected) toggles presenter mode.
    useCanvasHotkeys({
        selectedIds, onAskAssistant, editable, structuralEditsBlocked, readOnly, runtimeContextValue,
        onExecuteStep, runInFlight, onDuplicateNode, onDetachNode, onPinNode, togglePresenter,
    });

    // Connect gestures and per-edge controls ("+", "×", colour) — the
    // callbacks live in flow/useEdgeEditCallbacks.js, called from the same
    // hook position as before so hook order is unchanged.
    const {
        onConnect, onConnectEnd, onEdgesDelete,
        onEdgeDeleteClick, onEdgeSetColor, onEdgeInsertClick,
    } = useEdgeEditCallbacks({
        definition, editable, structuralEditsBlocked, onDefinitionChange,
        autoMapEnabled, catalog, realOutputById, onAutoMapped, inLoopBody,
        onRequestAddNode, onRequestInsertOnEdge, rf, absPositionOf,
    });

    // Delete via the Delete/Backspace key, the node's hover "🗑" button, or the
    // canvas context menu — all land here.
    //
    // `applyDeleteNodes` BRIDGES the graph rather than just pruning it: removing
    // a step from the middle of a flow used to drop every edge touching it,
    // silently severing the chain and stranding everything downstream as
    // unreachable roots (BFSF-319). It also keeps the primary-trigger guard —
    // the runtime requires exactly one — while letting secondary triggers
    // (definition.triggers[]) go like any other node.
    const onNodesDelete = useCallback((deleted) => {
        if (!editable || structuralEditsBlocked) return;
        if (!deleted || deleted.length === 0) return;
        const ids = deleted.map(n => n.id).filter(id => !inlineTriggerIds.has(id));
        if (ids.length === 0) return;
        const next = applyDeleteNodes(definition, ids);
        if (next === definition) return; // nothing removable (e.g. primary trigger only)
        onDefinitionChange?.(seedPositions(next));
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange, inlineTriggerIds]);

    // Right-click a node → the delete/duplicate menu. Anchored in VIEWPORT
    // coordinates because the menu portals to document.body, outside the React
    // Flow transform.
    const [ctxMenu, setCtxMenu] = useState(null); // { stepId, x, y }
    const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
    const onNodeContextMenu = useCallback((event, node) => {
        if (!editable || structuralEditsBlocked || !node?.id) return;
        // The step menu (run / duplicate / disconnect / delete) has no meaning
        // for a tool chip — every entry would act on an id no step has.
        if (isToolNodeId(node.id)) return;
        event.preventDefault();
        setCtxMenu({ stepId: node.id, x: event.clientX, y: event.clientY });
    }, [editable, structuralEditsBlocked]);
    // A pan/zoom would leave the menu floating over the wrong node.
    useEffect(() => { if (ctxMenu) closeCtxMenu();   }, [definition]);

    // Drag a step in from the ribbon / add-step menu, plus the double-click
    // drill-in — state and callbacks live in flow/useStepDrop.js, called from
    // the same hook position as before so hook order is unchanged.
    const {
        dropTarget, onDragOver, onDragLeave, onNodeDoubleClick, onDrop,
    } = useStepDrop({
        editable, structuralEditsBlocked, definition, edges,
        onDropStep, onDefinitionChange, onStepAdded, rf, scopeAtPoint, catalog,
        wrapperRef, onNodeExpand, onOpenLayer, hasInline, sidecar,
    });

    // Edge/node decoration pipeline (edge controls, drop-target accents,
    // AI-tool satellites, identity colours, run decoration) and the Arrange
    // action — flow/useRenderedGraph.js, called from the same hook position
    // as before so hook order is unchanged.
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
        // The first screen of a new automation (BFSF-327) — see
        // flow/DiagramEmptyState.jsx. React Flow is not mounted yet, so the
        // build cue lives here through the prompt processing before the first
        // token — the worst dead air of a build.
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

    // Which flowlet the right-clicked node calls, if any — drives the menu's
    // Expand/Collapse entry.
    const ctxMenuLayerKey = ctxMenu
        ? ((definition?.steps || []).find(s => s.id === ctxMenu.stepId && s.type === 'call_layer')?.layerKey || null)
        : null;

    const interactive = !readOnly;
    const allowDrag = editable && !structuralEditsBlocked;
    const allowConnect = editable && !structuralEditsBlocked;
    // Click-to-inspect is decoupled from readOnly: a caller that passes an
    // onNodeClick handler (e.g. RunExecutionView's click-to-inspect-a-run-step
    // panel) wants node clicks even though the canvas is read-only for editing.
    // Static thumbnails (Quick/Expert) pass no handler, so they stay inert.
    const clickable = typeof onNodeClick === 'function';
    // The Fit button outside a build: the whole flow, clear of the furniture.
    const fitCanvasFully = () => fitAroundFurniture({ duration: 300 });
    // The one selected card is the one open in the drawer: its actions are in
    // the drawer's header, and the selection bar would repeat them in the
    // strip of canvas left above it.
    const selectionInDrawer = !!editingStepId && selectedIds.length === 1 && selectedIds[0] === editingStepId;

    return (
        <PresenterContext.Provider value={presenter}>
        <NodeRuntimeContext.Provider value={runtimeContextValue}>
        <div
            ref={wrapperRef}
            // While a step is open in the drawer the host sets the canvas's
            // floor (BuildTab: 220px); a floor of our own would run the pane
            // under the drawer, zoom stack and minimap included.
            className={`w-full h-full relative ${editingStepId ? '' : 'min-h-[320px]'}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            // Present while the choreography is live — a styling hook for the
            // building state, absent under reduced motion so nothing keys on it
            // when today's behaviour is what plays.
            data-building={structuralEditsBlocked && !reducedMotion ? '' : undefined}
            // Presenter mode (flow/presenterMode.js): the stylesheet's hook for
            // the bigger south bar, badges and ghost caption.
            data-presenter={presenter ? 'on' : undefined}
        >
            <ReactFlow
                nodes={nodesWithDropTarget}
                edges={renderedEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={edgeTypes}
                defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
                // Any viewport move we did not start is the presenter taking
                // the camera (flow/useBuildChoreography.js).
                onMoveStart={onMoveStartGuarded}
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
                fitViewOptions={mountFitOptions}
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
                onNodeClick={clickable ? onNodeClickWithSelection : undefined}
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
                <Background gap={16} size={1} color="var(--border-default)" />
                <DiagramOverlays
                    definition={definition}
                    allowEdgeEdits={allowEdgeEdits}
                    handleArrange={handleArrange}
                    structuralEditsBlocked={structuralEditsBlocked}
                    reducedMotion={reducedMotion}
                    resumeFollow={resumeFollow}
                    fitCanvasFully={fitCanvasFully}
                    presenter={presenter}
                    togglePresenter={togglePresenter}
                    shortCanvas={shortCanvas}
                    onToggleFlowlets={onToggleFlowlets}
                    flowletsOpen={flowletsOpen}
                    flowletCount={flowletCount}
                    runFocus={runFocus}
                    focusRunStep={focusRunStep}
                    formUrl={formUrl}
                    onOpenFormOverlay={onOpenFormOverlay}
                    selectedCount={selectedIds.length}
                    selectionInDrawer={selectionInDrawer}
                    deleteSelection={deleteSelection}
                    clearSelection={clearSelection}
                    interactive={interactive}
                    editable={editable}
                    buildCue={buildCue}
                    following={following}
                    editingStepId={editingStepId}
                    stepNumberById={runtimeContextValue.stepNumberById}
                    fatalError={fatalError}
                    validation={validation}
                    aborted={aborted}
                    onDismissFatal={onDismissFatal}
                    onFocusStep={onFocusStep}
                    edgeColorMode={edgeColorMode}
                    setEdgeColorMode={setEdgeColorMode}
                    onDefinitionChange={onDefinitionChange}
                    hasPiiData={hasPiiData}
                    legendOpen={legendOpen}
                    toggleLegend={toggleLegend}
                    typeGroupById={runtimeContextValue.typeGroupById}
                />
            </ReactFlow>
            {/* The ghosts flying from the ribbon to their slots. Portalled to
                <body> by the layer itself, but MOUNTED here so it unmounts with
                the canvas and no ghost outlives the pane it was aimed at. */}
            <RibbonFlightLayer ghosts={flightGhosts} rf={rf} nodes={computedNodes} />
            {ctxMenu && (
                <NodeContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    canDelete={canDeleteNode(definition, ctxMenu.stepId)}
                    canDuplicate={canDuplicateNode(definition, ctxMenu.stepId)}
                    canDetach={canDetachNode(definition, ctxMenu.stepId)}
                    onDuplicate={() => onDuplicateNode(ctxMenu.stepId)}
                    onDetach={() => onDetachNode(ctxMenu.stepId)}
                    onDelete={() => onDeleteNode(ctxMenu.stepId)}
                    onExecute={onExecuteStep && !runInFlight ? () => onExecuteStep(ctxMenu.stepId) : null}
                    onToggleInline={ctxMenuLayerKey && onToggleInline ? () => onToggleInline(ctxMenu.stepId, ctxMenuLayerKey) : null}
                    inlineExpanded={inlineExpandedIds.has(ctxMenu.stepId)}
                    onAskAssistant={onAskAssistant ? () => onAskAssistant(ctxMenu.stepId) : null}
                    onClose={closeCtxMenu}
                />
            )}
            {/* "Let go and I'll wire it up" — follows the cursor while a loose
                node is dragged next to a connection or another node, so the
                highlight isn't left to guesswork. */}
            {nodeDropTarget && dropHintPos && (
                <div
                    className="absolute z-30 pointer-events-none px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-white shadow-lg whitespace-nowrap"
                    style={{ left: dropHintPos.x + 16, top: dropHintPos.y + 16 }}
                >
                    {nodeDropTarget.kind === 'edge' ? 'Release to insert here' : 'Release to connect'}
                </div>
            )}
        </div>
        </NodeRuntimeContext.Provider>
        </PresenterContext.Provider>
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
