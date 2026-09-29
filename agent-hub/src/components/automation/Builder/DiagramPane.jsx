import {
    ReactFlow, ReactFlowProvider, Background, MiniMap, Panel,
    useReactFlow, useStore, useStoreApi, MarkerType, applyNodeChanges,
} from '@xyflow/react';
import { Layers } from 'lucide-react';
import React, { forwardRef, useMemo, useCallback, useRef, useState, useEffect, useImperativeHandle } from 'react';
import '@xyflow/react/dist/style.css';

import { NodeRuntimeContext } from './flow/NodeRuntimeContext';
import { PresenterContext } from './flow/PresenterContext';
import { isToolNodeId, parseToolNodeId } from './flow/aiToolNodes';
import { applyPresenterShots, readPresenter, writePresenter } from './flow/presenterMode';
import DiagramEmptyState from './flow/DiagramEmptyState';
import { EdgeCrossingProvider } from './flow/EdgeCrossingContext';
import { edgeTypes } from './flow/edges';
import { CONTAINER_HEADER, isInlineId, parseInlineId, prefixAddedStep } from './flow/inlineFlowlets';
import { flowOrder } from './flow/flowOrder';
import { miniMapColor } from './flow/nodeTypeColors';
import { stepFamily } from './flow/nodeDefs';
import { buildLayout, seedPositions } from './flow/layout';
import LineColorPanel from './flow/LineColorPanel';
import CanvasZoomStack from './flow/CanvasZoomStack';
import CanvasLegend, { LegendToggle } from './flow/CanvasLegend';
import FlowSummaryChip from './flow/FlowSummaryChip';
import CanvasSouthBar from './flow/CanvasSouthBar';
import ArrangeMenu from './flow/ArrangeMenu';
import FloatingValidationPill from './FloatingValidationPill';
import { spotlightKeysFor } from './flow/ghostDraft';
import useTranslation from '../../../hooks/useTranslation';
import { buildIssuesByStep } from './flow/matchValidationToStep';
import NodeContextMenu from './flow/NodeContextMenu';
import {
    applyDeleteNodes, applyDuplicateNode, applyDetachNode, applyPatchStep,
    canDeleteNode, canDuplicateNode, canDetachNode,
} from './flow/nodeOps';
import { NODE_TYPES } from './flow/nodeTypes';
import RibbonFlightLayer from './flow/RibbonFlightLayer';
import { computeRunFocus } from './flow/runFocus';
import { effectiveRunByStep } from './flow/runStatus';
import { useBuildChoreography } from './flow/useBuildChoreography';
import { useCanvasWheel } from './flow/useCanvasWheel';
import { useEdgeEditCallbacks } from './flow/useEdgeEditCallbacks';
import { useFurnitureFit } from './flow/useFurnitureFit';
import { useLegendPreference } from './flow/useLegendPreference';
import { useNodeDragWiring } from './flow/useNodeDragWiring';
import { selectMeasuredIds, useOpeningFit } from './flow/useOpeningFit';
import { useReducedMotion } from './flow/useReducedMotion';
import { useRenderedGraph } from './flow/useRenderedGraph';
import { useRibbonFlight, FLIGHT_TOTAL_MS } from './flow/useRibbonFlight';
import { useRibbonSpotlight } from './flow/useRibbonSpotlight';
import { useStepDrop } from './flow/useStepDrop';
import scopedStorage from '../../../utils/scopedStorage';

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

// The dry-run replay's camera (see the block by useDryRunReplay's consumer
// below): one 300 ms centring per revealed card, owned for its duration plus
// the same slack the choreography keeps, never below 80% — the LOD at which
// the result chip is drawn.
const REPLAY_CENTER_MS = 300;
const REPLAY_OWN_SLACK_MS = 80;
const REPLAY_MIN_ZOOM = 0.8;

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
    definition,
    runSteps = [],
    onNodeClick,
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
    onDropStep,         // (payload, { position, sourceId?, targetId?, label?, caseName? }) — a step dragged in from the ribbon
    onExecuteStep,      // (stepId) — n8n-style per-node ▶ button
    executingStepId = null,
    runInFlight = false,
    catalog = null,           // tool catalog — needed for auto-mapping on connect
    realOutputById = null,    // Map<stepId, output> (mapping/realOutputs) — real run/pinned data for auto-map + chips
    autoMapEnabled = true,    // auto-map inputs when an edge is drawn
    onAutoMapped,             // (stepId, count) — fired after a successful auto-map
    onOpenLayer,              // (layerKey) — drill into an inline flowlet's sub-canvas
    layerSummaries = {},      // { layerKey: description } — shown on call_layer nodes
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
    layerRefCounts = {},      // { layerKey: callSiteCount }
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
    // The routine's public form page. Only ever used by the run banner, and
    // only while a run is parked on a form (design 1d, "Formulier openen").
    formUrl = null,
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
}, ref) {
    return (
        <ReactFlowProvider>
            {/* Lets each edge see where the others are drawn, so a crossing gets
                a bridge instead of an ambiguous junction. Wraps the whole pane
                rather than the canvas, so it survives a canvas remount. */}
            <EdgeCrossingProvider>
            <DiagramPaneInner
                ref={ref}
                onOpenLayer={onOpenLayer}
                layerSummaries={layerSummaries}
                definition={definition}
                runSteps={runSteps}
                onNodeClick={onNodeClick}
                onNodeExpand={onNodeExpand}
                onDefinitionChange={onDefinitionChange}
                validation={validation}
                readOnly={readOnly}
                editable={editable}
                structuralEditsBlocked={structuralEditsBlocked}
                onRequestAddNode={onRequestAddNode}
                onRequestOpenPalette={onRequestOpenPalette}
                onRequestAddAfter={onRequestAddAfter}
                onRequestInsertOnEdge={onRequestInsertOnEdge}
                onDropStep={onDropStep}
                onExecuteStep={onExecuteStep}
                executingStepId={executingStepId}
                runInFlight={runInFlight}
                catalog={catalog}
                realOutputById={realOutputById}
                autoMapEnabled={autoMapEnabled}
                onAutoMapped={onAutoMapped}
                onStepAdded={onStepAdded}
                highlightedStepId={highlightedStepId}
                sidecar={sidecar}
                shiftById={shiftById}
                onToggleInline={onToggleInline}
                onExpandAllFlowlets={onExpandAllFlowlets}
                onCollapseAllFlowlets={onCollapseAllFlowlets}
                layerRefCounts={layerRefCounts}
                flowletsOpen={flowletsOpen}
                onToggleFlowlets={onToggleFlowlets}
                flowletCount={flowletCount}
                fatalError={fatalError}
                aborted={aborted}
                onDismissFatal={onDismissFatal}
                onFocusStep={onFocusStep}
                onAddTrigger={onAddTrigger}
                onOpenAssistant={onOpenAssistant}
                editingStepId={editingStepId}
                formUrl={formUrl}
                buildCue={buildCue}
                ribbonRootRef={ribbonRootRef}
                replayStepId={replayStepId}
                cameraInsetLeft={cameraInsetLeft}
            />
            </EdgeCrossingProvider>
        </ReactFlowProvider>
    );
});

export default DiagramPane;

const DiagramPaneInner = forwardRef(function DiagramPaneInner({
    definition, runSteps, onNodeClick, onNodeExpand, onDefinitionChange,
    validation, readOnly, editable, structuralEditsBlocked,
    onRequestAddNode, onRequestOpenPalette, onRequestAddAfter, onRequestInsertOnEdge,
    onDropStep = null,
    onExecuteStep, executingStepId, runInFlight,
    catalog = null, realOutputById = null, autoMapEnabled = true, onAutoMapped, onOpenLayer,
    layerSummaries = {},
    onDiagnose = null,
    onStepAdded,
    highlightedStepId = null,
    sidecar = null,
    shiftById = null,
    onToggleInline = null,
    onExpandAllFlowlets = null,
    onCollapseAllFlowlets = null,
    layerRefCounts = {},
    flowletsOpen = false, onToggleFlowlets = null, flowletCount = 0,
    fatalError = null, aborted = null, onDismissFatal = null, onFocusStep = null,
    onAddTrigger = null, onOpenAssistant = null,
    editingStepId = null,
    formUrl = null,
    buildCue = null,
    ribbonRootRef = null,
    replayStepId = null,
    cameraInsetLeft = 0,
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
    const hasInline = !!sidecar && sidecar.size > 0;
    const inlineExpandedIds = useMemo(() => new Set(sidecar ? sidecar.keys() : []), [sidecar]);
    const inlineTriggerIds = useMemo(
        () => new Set(sidecar ? [...sidecar.values()].map(e => e.triggerId).filter(Boolean) : []),
        [sidecar],
    );
    // Expanded LOOP containers, by prefix. A loop body is an ordered array with
    // no edges of its own: the chain on screen IS the order, derived on the way
    // in and read back on the way out (flow/loopBodyEdges.js). So the gestures
    // that change order all work, and the ones that would draw something the
    // runtime can't do — a free-hand connection, deleting a link — are refused
    // rather than silently undone by the next render.
    const loopPrefixes = useMemo(
        () => new Set(sidecar ? [...sidecar.values()].filter(e => e.kind === 'loop').map(e => e.prefix) : []),
        [sidecar],
    );
    const inLoopBody = useCallback(
        (nodeId) => loopPrefixes.size > 0 && loopPrefixes.has(parseInlineId(nodeId).prefix),
        [loopPrefixes],
    );

    /**
     * A node's absolute canvas position. React Flow stores a node inside an
     * expanded flowlet relative to its container, so anything that hands a
     * position OUT of this component has to add the ancestors back on.
     */
    const absPositionOf = useCallback((node) => {
        if (!node?.position) return null;
        let { x, y } = node.position;
        let parent = node.parentId;
        while (parent) {
            const pn = rf.getNode?.(parent);
            if (!pn?.position) break;
            x += pn.position.x;
            y += pn.position.y;
            parent = pn.parentId;
        }
        return { x, y };
    }, [rf]);

    /**
     * Which graph a canvas point belongs to: the innermost expanded flowlet
     * whose box contains it (its header strip excluded — dropping on the title
     * bar means "next to the flowlet", not "into it"), or '' for the canvas's
     * own graph.
     */
    const scopeAtPoint = useCallback((point) => {
        if (!hasInline || !point) return '';
        let best = '';
        for (const [prefix, entry] of sidecar) {
            const abs = absPositionOf(rf.getNode?.(prefix));
            if (!abs) continue;
            const inside = point.x >= abs.x && point.x <= abs.x + entry.size.width
                && point.y >= abs.y + CONTAINER_HEADER && point.y <= abs.y + entry.size.height;
            if (inside && prefix.length > best.length) best = prefix;
        }
        return best;
    }, [hasInline, sidecar, rf, absPositionOf]);
    const wrapperRef = useRef(null);

    // Wheel, touchpad and pinch (flow/useCanvasWheel.ts): two fingers pan,
    // a pinch zooms around the fingers, a mouse wheel zooms as it always did.
    // Needs the wrapper, so it waits for a trigger (the empty state has none).
    const rfStore = useStoreApi();
    useCanvasWheel({ wrapperRef, rf, store: rfStore, enabled: !readOnly && !!definition?.trigger });

    // ── Presenter mode (flow/presenterMode.js) ───────────────────────────
    // Bigger text for a projector: the cards re-derive their LOD from
    // PresenterContext (flow/useZoomLod.js), the stylesheet keys on
    // `data-presenter` on the wrapper, edges.jsx thickens the lines, and the
    // build's push-in frames tighter (applyPresenterShots). A per-user
    // preference, read once on mount. Toggled from the zoom stack, Shift+P,
    // or P with nothing selected (plain P on a selected card is "freeze the
    // output").
    const [presenter, setPresenter] = useState(readPresenter);
    const togglePresenter = useCallback(() => {
        const next = !presenter;
        writePresenter(next);
        setPresenter(next);
    }, [presenter]);
    useEffect(() => {
        applyPresenterShots(presenter);
        return () => applyPresenterShots(false);
    }, [presenter]);

    // Clicking a node opens its focused Node Detail View (NDV) — owned by the
    // parent (BuilderShell). The canvas itself no longer renders any
    // node-anchored panels.

    // Primary run rows + synthetic 'pinned' stubs for pinned nodes without a
    // run row — so a pin alone still yields edge chips and node status (e.g.
    // after a reload, when in-memory run state is gone but pins persist).
    const runByStep = useMemo(() => effectiveRunByStep(definition, runSteps), [definition, runSteps]);

    // "Colour lines by" — a per-user presentational lens (never part of the
    // definition: it would pollute version diffs for zero shared value).
    // 'branches' by default: automatic case colours only touch case edges,
    // and manual colours render in every mode.
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
    const [edgeColorMode, setEdgeColorModeState] = useState(
        () => {
            const v = scopedStorage.getItem('builderEdgeColorMode');
            return v === 'off' || v === 'pii' ? v : 'branches';
        },
    );
    const setEdgeColorMode = useCallback((mode) => {
        setEdgeColorModeState(mode);
        scopedStorage.setItem('builderEdgeColorMode', mode);
    }, []);
    // The PII option only means something once a loaded run step carries a
    // pii summary (builder test-runs with the Privacy Shield applied to
    // routines) — offered disabled with an explanatory tooltip until then.
    const hasPiiData = useMemo(() => {
        for (const r of runByStep.values()) if (r?.piiSummary) return true;
        return false;
    }, [runByStep]);

    const issuesByStep = useMemo(
        () => buildIssuesByStep(validation, definition, sidecar),
        [validation, definition, sidecar],
    );

    // Per-node delete / duplicate. Reached from the node's hover chrome, the
    // canvas context menu, and the node detail view — three surfaces, one pair
    // of handlers (BFSF-319). Declared ABOVE runtimeContextValue because that
    // memo publishes them to every node component.
    //
    // Read their inputs through a ref so the callbacks keep a STABLE identity.
    // `onDefinitionChange` is BuilderShell's `onVisualEdit`, whose useCallback
    // depends on the draft-history object — recreated every render — so a
    // normal dep array would churn `runtimeContextValue` on every render and
    // re-render all 23 node components each time.
    const nodeOpsRef = useRef(null);
    nodeOpsRef.current = { definition, editable, structuralEditsBlocked, onDefinitionChange, catalog, realOutputById, autoMapEnabled, onAutoMapped, inlineTriggerIds };

    const onDeleteNode = useCallback((stepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit, inlineTriggerIds: protectedIds } = nodeOpsRef.current;
        if (!ed || blocked || !stepId) return;
        // The layer_input of an expanded flowlet: its mini-definition requires
        // exactly one, so there is nothing sensible to do here.
        if (protectedIds?.has?.(stepId)) return;
        const next = applyDeleteNodes(def, stepId);
        if (next === def) return; // primary trigger / unknown id
        emit?.(seedPositions(next));
    }, []);

    // "Remove it from the connection" — unwire the step but keep it. The
    // definition it emits already carries the parked position, so this must NOT
    // go through a re-layout; seedPositions leaves set positions alone.
    const onDetachNode = useCallback((stepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current;
        if (!ed || blocked || !stepId) return;
        const next = applyDetachNode(def, stepId);
        if (next === def) return; // not a step, or already loose
        emit?.(seedPositions(next));
    }, []);

    const onDuplicateNode = useCallback((stepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current;
        if (!ed || blocked || !stepId) return;
        const { definition: next, newStepId } = applyDuplicateNode(def, stepId);
        if (!newStepId) return; // triggers aren't duplicable
        // The copy of a step inside an expanded flowlet belongs to that
        // flowlet — without the prefix it would land in the flow around it.
        const { prefix } = parseInlineId(stepId);
        emit?.(seedPositions(prefix ? prefixAddedStep(next, newStepId, prefix) : next));
    }, []);

    // A node writing back its OWN fields (BFSF-411: a note's inline
    // text/size/color edits). No re-layout — unlike the graph-surgery ops
    // above, this never touches wiring or position, so seedPositions would
    // be a no-op anyway.
    const onPatchStep = useCallback((stepId, patch) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current;
        if (!ed || blocked || !stepId) return;
        const next = applyPatchStep(def, stepId, patch);
        if (next === def) return;
        emit?.(next);
    }, []);

    // Freeze / release a step's last output from the card (the redesign's
    // fifth action). Writes exactly the patch NodeDetailView's Pin button
    // writes, so the two cannot drift: pinnedSource stays undefined on both
    // paths — only the Edit-output editor sets it to 'edited'.
    const onPinNode = useCallback((stepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current;
        if (!ed || blocked || !stepId) return;
        const all = [def?.trigger, ...(def?.triggers || []), ...(def?.steps || [])].filter(Boolean);
        const step = all.find(st => st.id === stepId);
        if (!step) return;
        const isPinned = step.pinnedOutput !== undefined && step.pinnedOutput !== null;
        let patch;
        if (isPinned) {
            patch = { pinnedOutput: null, pinnedAt: null, pinnedSource: undefined };
        } else {
            const row = runByStepRef.current?.get?.(stepId);
            if (!row || row.output === undefined || row.status === 'pinned') return;
            patch = { pinnedOutput: row.output, pinnedAt: new Date().toISOString(), pinnedSource: undefined };
        }
        const next = applyPatchStep(def, stepId, patch);
        if (next === def) return;
        emit?.(next);
    }, []);
    const runByStepRef = useRef(runByStep);
    runByStepRef.current = runByStep;

    // Derive runtime context: which steps are pinned / disabled / mid-run.
    // The 17 per-type node components read this via NodeRuntimeContext so
    // their call-sites stay unchanged. The build-choreography flags join it
    // further down (`runtimeContextValue`), once the hook that owns them has
    // run — they need the laid-out nodes this memo runs before.
    const baseRuntimeContext = useMemo(() => {
        const pinnedById = new Set();
        const disabledById = new Set();
        // Custom per-step symbol (a Lucide icon name set in the inspector).
        // StepNodeBase reads this to override the default type icon.
        const customIconById = new Map();
        const allSteps = [definition?.trigger, ...(definition?.steps || [])].filter(Boolean);
        for (const s of allSteps) {
            if (s.pinnedOutput !== undefined && s.pinnedOutput !== null) pinnedById.add(s.id);
            if (s.disabled) disabledById.add(s.id);
            if (s.icon) customIconById.set(s.id, s.icon);
        }
        // Run ordinal — 1-based by finishedAt — so users can see "3/8" on
        // the currently running node. The node still showing 'running'
        // gets ordinal = (count of completed) + 1. 'pinned' steps count as
        // completed for ordering — they're synthetic but the user wants
        // to see their position in the run.
        const ordered = (runSteps || []).filter(s => s.stepId && (s.status === 'success' || s.status === 'skipped' || s.status === 'pinned'))
            .slice().sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
        const runIndexById = new Map();
        ordered.forEach((s, i) => runIndexById.set(s.stepId, i + 1));
        const runningStep = (runSteps || []).find(s => s.status === 'running');
        if (runningStep?.stepId) runIndexById.set(runningStep.stepId, ordered.length + 1);
        const runTotal = allSteps.length - 1; // exclude trigger

        // ── Card identity (builder redesign) ──────────────────────────────
        // The family paints the 4px bar and the tile; the number is the
        // step's place in RUN order — the same sequence the node editor pages
        // through — so "step 7" means the same thing on the canvas and in
        // the editor's header. A step inside an expanded container reads
        // `<container number>·<its place inside>`, matching the design's
        // "13 · 1".
        const everyNode = [definition?.trigger, ...(definition?.triggers || []), ...(definition?.steps || [])].filter(Boolean);
        const triggerIdSet = new Set([
            definition?.trigger?.id,
            ...(definition?.triggers || []).map(t => t?.id),
            ...inlineTriggerIds,
        ].filter(Boolean));
        const typeGroupById = new Map();
        const stepTypeById = new Map();
        for (const st of everyNode) {
            const type = triggerIdSet.has(st.id) ? 'trigger' : (st.type || 'integration_action');
            stepTypeById.set(st.id, type);
            typeGroupById.set(st.id, stepFamily(type));
        }
        const stepNumberById = new Map();
        {
            const order = flowOrder(definition);
            let n = 0;
            const inner = new Map(); // prefix -> counter
            const topNumber = new Map(); // prefix -> its own number
            for (const id of order) {
                if (stepTypeById.get(id) === 'note') continue;
                if (!isInlineId(id)) {
                    n += 1;
                    stepNumberById.set(id, n);
                    topNumber.set(id, n);
                    continue;
                }
                const { prefix } = parseInlineId(id);
                if (inlineTriggerIds.has(id) || stepTypeById.get(id) === 'loop_item') continue;
                const k = (inner.get(prefix) || 0) + 1;
                inner.set(prefix, k);
                const parent = topNumber.get(prefix) ?? stepNumberById.get(prefix);
                stepNumberById.set(id, parent != null ? `${parent}·${k}` : k);
            }
        }
        // A pin needs a captured output. A synthetic 'pinned' row IS the pin.
        const pinnableIds = new Set();
        for (const [id, row] of runByStep) {
            if (row && row.output !== undefined && row.status !== 'pinned') pinnableIds.add(id);
        }

        // While the drawer edits a step, its direct source is drawn dashed
        // and what comes next is dimmed (design 1h).
        const editingSourceIds = new Set();
        const editingTargetIds = new Set();
        if (editingStepId) {
            for (const e of (definition?.edges || [])) {
                if (e?.to === editingStepId && e.from) editingSourceIds.add(e.from);
                if (e?.from === editingStepId && e.to) editingTargetIds.add(e.to);
            }
        }
        return {
            typeGroupById,
            stepTypeById,
            stepNumberById,
            pinnableIds,
            editingStepId,
            editingSourceIds,
            editingTargetIds,
            onPinNode: (editable && !structuralEditsBlocked) ? onPinNode : null,
            pinnedById,
            disabledById,
            customIconById,
            onExecuteStep: editable ? onExecuteStep : null,
            executingStepId,
            runInFlight,
            runIndexById,
            runTotal,
            onOpenLayer: onOpenLayer || null,
            layerSummaries: layerSummaries || {},
            highlightedStepId,
            // Node actions (BFSF-319). Null on a read-only canvas or while the
            // AI holds structural edits, so StepNodeBase renders no chrome.
            onDeleteNode: (editable && !structuralEditsBlocked) ? onDeleteNode : null,
            onDuplicateNode: (editable && !structuralEditsBlocked) ? onDuplicateNode : null,
            onDetachNode: (editable && !structuralEditsBlocked) ? onDetachNode : null,
            // A node writing back its own fields — a note's inline text/size/
            // color edits (BFSF-411). Same editability gate as the actions
            // above; a read-only canvas renders the note but cannot change it.
            onPatchStep: (editable && !structuralEditsBlocked) ? onPatchStep : null,
            // Which nodes are wired to anything — the Disconnect button is
            // pointless on a loose card, so it isn't rendered there. Nor on a
            // step inside a loop: its links are derived from the body's order,
            // so "take it out of the flow" would be undone on the next render.
            // Deleting it, or dragging it somewhere else in the chain, are the
            // two things that mean something there.
            attachedIds: new Set(
                (definition?.edges || [])
                    .flatMap(e => [e.from, e.to])
                    .filter(id => id && !inLoopBody(id)),
            ),
            primaryTriggerId: definition?.trigger?.id || null,
            // A flowlet's `layer_input` node is its trigger, so it gets the
            // same treatment as one: never duplicated, never detached, and —
            // since its mini-definition needs exactly one — never deleted.
            triggerIds: new Set([
                definition?.trigger?.id,
                ...(definition?.triggers || []).map(t => t?.id),
                ...inlineTriggerIds,
            ].filter(Boolean)),
            undeletableIds: inlineTriggerIds,
            // Expand/collapse a flowlet in place. Offered on a read-only canvas
            // too — looking inside a sub-flow isn't an edit.
            onToggleInline,
            inlineExpanded: inlineExpandedIds,
            layerRefCounts,
        };
    }, [definition, runSteps, runByStep, onExecuteStep, executingStepId, runInFlight, editable, structuralEditsBlocked, onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, layerRefCounts, onPatchStep, onPinNode, editingStepId]);

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

    // ── Live drag mirror ────────────────────────────────────────────────
    //
    // React Flow is in controlled mode — `nodes` is the source of truth
    // and it does NOT animate drags by itself. If we keep using the
    // computed-from-definition nodes directly, the visual stays frozen
    // while the user drags (definition only updates on drag-end). So we
    // mirror computedNodes into local state and apply React Flow's
    // position changes on every onNodesChange tick. The definition is
    // still only written at drag-end via commitNodePositions, so we
    // don't thrash buildLayout / the debounced save round-trip.
    const [nodes, setNodes] = useState(computedNodes);
    // Track whether ReactFlow is currently dragging a node. If `definition`
    // updates mid-drag (e.g. an autosave round-trip rewrites positions),
    // unconditional sync would snap the dragged node back to the persisted
    // position. We sync immediately on a non-drag definition change, and
    // defer the sync to drag-end otherwise.
    const isDraggingRef = useRef(false);
    const pendingComputedRef = useRef(null);
    // `buildLayout` rebuilds nodes from the definition, and those fresh objects
    // carry no `selected` flag — so every re-layout (a run tick, a validation
    // pass, an autosave round-trip) silently dropped the user's selection and
    // multi-select looked broken. Selection is view state, not document state:
    // carry it across the sync.
    const carrySelection = useCallback((next) => {
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

    // ── The dry run, replayed (flow/useDryRunReplay.js) ─────────────────
    // BuildTab reveals the test run's rows one at a time and names the row
    // being revealed; the camera centres on that card, keeping the zoom (at
    // least 80%, so the chip is legible). Our own setCenter reaches React
    // Flow's onMoveStart like any gesture, so — the choreography's rule — the
    // move is OWNED for its duration and the guarded handler below lets it
    // pass; a move we did NOT start while a replay is on is the presenter
    // taking the camera, and the replay stops moving it until the next one.
    // `following === false` (the build film has already yielded) is honoured
    // for the same reason. One move per id: a re-render with the same id, or
    // `following` flipping, never re-centres.
    const replayOwnUntilRef = useRef(0);
    const replayYieldedRef = useRef(false);
    const replayActiveRef = useRef(false);
    const replayCenteredRef = useRef(null);
    useEffect(() => { replayActiveRef.current = replayStepId != null; }, [replayStepId]);
    useEffect(() => {
        if (replayStepId == null) {
            replayYieldedRef.current = false;
            replayCenteredRef.current = null;
            return;
        }
        if (replayCenteredRef.current === replayStepId) return;
        replayCenteredRef.current = replayStepId;
        if (replayYieldedRef.current || following === false) return;
        const node = rf?.getNode?.(replayStepId);
        const abs = absPositionOf(node);
        if (!abs || typeof rf?.setCenter !== 'function') return;
        const zoom = Math.max(Number(rf.getZoom?.()) || 1, REPLAY_MIN_ZOOM);
        replayOwnUntilRef.current = Date.now() + REPLAY_CENTER_MS + REPLAY_OWN_SLACK_MS;
        rf.setCenter(
            abs.x + (node.measured?.width ?? node.width ?? 240) / 2,
            abs.y + (node.measured?.height ?? node.height ?? 72) / 2,
            { duration: REPLAY_CENTER_MS, zoom },
        );
    }, [replayStepId, following, rf, absPositionOf]);
    const onMoveStartGuarded = useCallback((ev, viewport) => {
        if (Date.now() < replayOwnUntilRef.current) return;
        if (replayActiveRef.current) replayYieldedRef.current = true;
        onMoveStart(ev, viewport);
    }, [onMoveStart]);
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
    }, [editable, commitNodePositions]);

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

    // ── Keyboard equivalents of the action chrome ────────────────────────
    //
    // R (run up to here) · D (duplicate) · U (disconnect) · P (pin). One
    // document listener for the whole canvas, not one per card, gated on
    // exactly one selected node. Bare letters must never fire while the user
    // is typing — the assistant composer, a note's inline text, the search
    // box — so anything editable swallows them; modifier combos are left to
    // useBuilderHotkeys.
    useEffect(() => {
        if (!editable || structuralEditsBlocked || selectedIds.length !== 1) return undefined;
        const id = selectedIds[0];
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Shift+P is presenter mode (the listener below); never a pin.
            if (e.shiftKey) return;
            const el = e.target;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            const key = String(e.key || '').toLowerCase();
            const isTrigger = runtimeContextValue.triggerIds?.has?.(id);
            if (key === 'r' && onExecuteStep && !runInFlight) { e.preventDefault(); onExecuteStep(id, { mode: 'upTo' }); }
            else if (key === 'd' && !isTrigger) { e.preventDefault(); onDuplicateNode(id); }
            else if (key === 'u' && !isTrigger && runtimeContextValue.attachedIds?.has?.(id)) { e.preventDefault(); onDetachNode(id); }
            else if (key === 'p' && !isTrigger) { e.preventDefault(); onPinNode(id); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [editable, structuralEditsBlocked, selectedIds, runtimeContextValue, onExecuteStep, runInFlight, onDuplicateNode, onDetachNode, onPinNode]);

    // Presenter mode from the keyboard: Shift+P anywhere on the canvas, and
    // plain P only while nothing is selected — on a selected card P is "freeze
    // the output" (above). Same editable-field guard as the letters above.
    useEffect(() => {
        if (readOnly) return undefined;
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (String(e.key || '').toLowerCase() !== 'p') return;
            const el = e.target;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            if (!e.shiftKey && selectedIds.length !== 0) return;
            e.preventDefault();
            togglePresenter();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [readOnly, selectedIds, togglePresenter]);

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
        // The first screen of a new routine (BFSF-327) — see
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
                {/* South-west zone (design 1a): the zoom stack — with "Wrap to fit"
                    in it, the same kind of one-press act as fitView — then the
                    Flowlets drawer and the Arrange menu. All one Panel, so they
                    can never drift apart or overlap the minimap. The fit counts
                    each piece on its own (`data-furniture-parts`): the tall
                    stack and the short buttons are not one tall block. */}
                <Panel position="bottom-left">
                    <div className="flex items-end gap-2" data-furniture-parts>
                        {/* Fit hands the camera back to the film only while there is
                            one to follow; otherwise — and under reduced motion — it
                            is the canvas's own fit, clear of the furniture. */}
                        <CanvasZoomStack
                            onWrapToFit={allowEdgeEdits ? () => handleArrange('serpentine') : null}
                            onFit={structuralEditsBlocked && !reducedMotion ? resumeFollow : fitCanvasFully}
                            presenter={presenter}
                            onTogglePresenter={togglePresenter}
                            compact={shortCanvas}
                        />
                        {onToggleFlowlets && !shortCanvas && (
                            <button
                                type="button"
                                data-layers-toggle
                                onClick={onToggleFlowlets}
                                aria-pressed={!!flowletsOpen}
                                title="Flowlets — manage reusable sub-flows"
                                className={`inline-flex items-center gap-1.5 px-2.5 py-[6px] rounded-lg border border-[var(--border-default)] shadow-sm text-[12px] font-medium text-[var(--text-primary)] transition ${
                                    flowletsOpen ? 'bg-[var(--bg-tertiary)]' : 'bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)]'
                                }`}
                            >
                                <Layers size={14} /> {t('routines.canvas.flowlets', 'Flowlets')}
                                {flowletCount > 0 && <span className="text-[var(--text-tertiary)]">{flowletCount}</span>}
                            </button>
                        )}
                        {allowEdgeEdits && !shortCanvas && <ArrangeMenu onArrange={handleArrange} />}
                    </div>
                </Panel>
                {/* South edge: run banner OR build banner OR selection bar OR
                    gesture hint — one at a time, by precedence, so nothing
                    stacks. The build banner is also the lock notice while the
                    AI holds structural edits. Capped so it never runs under
                    the zoom stack or the minimap. */}
                <Panel position="bottom-center" style={{ maxWidth: 'calc(100% - 440px)' }}>
                    <CanvasSouthBar
                        runFocus={runFocus}
                        onShowRun={focusRunStep}
                        formUrl={formUrl}
                        selectedCount={selectedIds.length}
                        selectionInDrawer={selectionInDrawer}
                        onDeleteSelection={deleteSelection}
                        onClearSelection={clearSelection}
                        structuralEditsBlocked={structuralEditsBlocked}
                        interactive={interactive}
                        editable={editable}
                        buildCue={buildCue}
                        /* Under reduced motion the camera is never taken from
                           the build, so there is never anything to hand back. */
                        following={reducedMotion || following}
                        onFollow={resumeFollow}
                    />
                </Panel>
                {/* North-west zone: what the canvas holds, and what is wrong with
                    it. The validation chip used to float bottom-right, on top of
                    the minimap. */}
                <Panel position="top-left">
                    <div className="flex items-center gap-1.5">
                        {editingStepId ? (!shortCanvas && (
                            <div className="px-2.5 py-[5px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] text-[12px] text-[var(--text-secondary)] shadow-sm whitespace-nowrap" data-testid="editing-chip">
                                {t('routines.canvas.editing_chip', 'Step {n} of {total} · Esc closes · Alt+←/→ previous/next', {
                                    n: runtimeContextValue.stepNumberById.get(editingStepId) ?? '?',
                                    total: [...runtimeContextValue.stepNumberById.values()].filter(v => typeof v === 'number').length,
                                })}
                            </div>
                        )) : (
                            <FlowSummaryChip definition={definition} />
                        )}
                        <FloatingValidationPill
                            fatalError={fatalError}
                            validation={validation}
                            aborted={aborted}
                            onDismissFatal={onDismissFatal}
                            def={definition}
                            onFocusStep={onFocusStep}
                        />
                    </div>
                </Panel>
                {/* "Colour lines by" + the rules panel behind it — mode is a
                    per-user lens; the colour RULES (pin a case colour, remap a
                    PII group) edit the definition. Shown wherever connections
                    are; rule editing only on an editable canvas. */}
                {/* North-east zone: the "Lines" lens (where there are lines) and
                    the legend behind the help button. */}
                {!shortCanvas && (
                    <Panel position="top-right">
                        <div className="flex flex-col items-end gap-1.5">
                            <div className="flex items-start gap-1.5">
                                {(definition.edges || []).length > 0 && (
                                    <LineColorPanel
                                        mode={edgeColorMode}
                                        onModeChange={setEdgeColorMode}
                                        definition={definition}
                                        editable={allowEdgeEdits}
                                        onDefinitionChange={onDefinitionChange}
                                        hasPiiData={hasPiiData}
                                    />
                                )}
                                <LegendToggle open={legendOpen} onToggle={toggleLegend} />
                            </div>
                            {legendOpen && <CanvasLegend />}
                        </div>
                    </Panel>
                )}
                {!shortCanvas && <MiniMap
                    pannable
                    zoomable
                    // South-east zone: 160×96 (design 1a).
                    style={{ width: 160, height: 96, borderRadius: 10 }}
                    // The same family/status vocabulary the cards paint with
                    // (flow/nodeTypeColors.js), so the map agrees with the canvas.
                    nodeColor={(n) => ((n.type === 'row_label' || n.type === 'ai_tool' || n.type === 'ghost_step')
                        ? 'transparent'
                        : miniMapColor(runtimeContextValue.typeGroupById.get(n.id) || null, n.data?.runStep?.status || null))}
                    maskColor="rgba(0,0,0,0.04)"
                />}
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
