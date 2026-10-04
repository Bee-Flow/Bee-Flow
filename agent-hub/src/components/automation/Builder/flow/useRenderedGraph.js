import { useCallback, useMemo } from 'react';

import { buildAiToolGraph, detachTool, toolLabelIndex } from './aiToolNodes';
import { arrangeDefinition } from './arrange';
import { resolvePiiGroupColors } from './edgeColorOps';
import { decorateRunEdges, identityColorForEdge } from './edgeColoring';
import { seedPositions } from './layout';
import { rowBands, ROW_LABEL_OFFSET } from './rowBands';
import { SYNTHETIC_TYPES } from './nodeDefs';

// The z React Flow gives a selected node when it is allowed to elevate them —
// reproduced manually for non-note nodes only (BFSF-479, see below).
const SELECTED_NODE_Z = 1000;

/**
 * Selection layering (BFSF-479): the canvas sets elevateNodesOnSelect={false}
 * so a SELECTED note stays pinned to its background z-index (layout.js
 * NOTE_Z_INDEX) instead of popping +1000 over the nodes and connectors it
 * overlaps. This re-applies the pop to every selected node that is NOT a
 * note — the same lift React Flow would have given it.
 */
export function applySelectionLayering(nodes) {
    return (nodes || []).map((n) => (n.selected && n.type !== 'note' && !n.zIndex ? { ...n, zIndex: SELECTED_NODE_Z } : n));
}

// The decoration pipeline that turns the laid-out nodes/edges into what
// React Flow actually renders: edge action callbacks, drop-target accents,
// AI-tool satellites, row gutter labels, identity colours, build-choreography
// flags and run-state decoration — plus the Arrange action, which lives in
// the same seam because it reads the same inputs. Extracted from
// DiagramPaneInner verbatim: called from the same position, so hook order is
// unchanged.
//
// The build-choreography inputs (flow/useBuildChoreography.js) are all
// optional and empty outside a build: `buildFxById` marks cards mid-reveal,
// `freshEdgeKeys` the connections that draw in, and the ghost node/edge are
// the "next step" slot ahead of the frontier.
export function useRenderedGraph({
    editable, structuralEditsBlocked, onDefinitionChange, isDraggingRef,
    onExpandAllFlowlets, onCollapseAllFlowlets, wrapperRef, definition, rf,
    edges, onEdgeInsertClick, onEdgeDeleteClick, onEdgeSetColor,
    onNodeExpand, onNodeClick, inLoopBody, dropTarget, nodeDropTarget,
    catalog, nodes, runByStep, runInFlight, edgeColorMode,
    stepNumberById = null,
    // (options) => void — the canvas's furniture-aware fit (flow/useFurnitureFit.ts).
    fitCanvas = null,
    buildFxById = null, freshEdgeKeys = null, ghostNodes = null, ghostEdges = null,
}) {
    const allowEdgeEdits = editable && !structuralEditsBlocked;

    /**
     * Arrange — rewrite every position in the chosen shape.
     *
     * Goes out through `onDefinitionChange` like any other canvas edit, so it
     * is one draft commit and therefore one Ctrl+Z. That undo is what lets this
     * be a plain button press rather than a preview-and-confirm dance.
     */
    const handleArrange = useCallback((mode) => {
        if (!onDefinitionChange || !allowEdgeEdits) return;
        // A definition→nodes sync is deferred while a drag is in flight
        // (see the effect above), and an arrange fired mid-drag would be
        // swallowed by it. Doing nothing is honest; half-applying is not.
        if (isDraggingRef.current) return;
        // Positions are stored in COLLAPSED space — a 240x96 card per node — and
        // an expanded container is drawn much larger, with its neighbours pushed
        // aside at render time. So "tighten it up" and "make it fit" fold the
        // flowlets away first: otherwise the layout is measured against one
        // canvas and displayed on another, which is exactly how a wrapped flow
        // ended up wider than the screen it was wrapped for.
        if (mode === 'roomy') onExpandAllFlowlets?.();
        else onCollapseAllFlowlets?.();
        const box = wrapperRef.current?.getBoundingClientRect();
        onDefinitionChange(arrangeDefinition(definition, {
            mode,
            viewportWidth: box?.width || 0,
            viewportHeight: box?.height || 0,
        }));
        // Frame it once the new positions have rendered.
        requestAnimationFrame(() => {
            if (fitCanvas) { fitCanvas({ duration: 300 }); return; }
            try { rf.fitView({ padding: 0.08, duration: 300 }); } catch { /* canvas gone */ }
        });
    }, [definition, onDefinitionChange, allowEdgeEdits, onExpandAllFlowlets, onCollapseAllFlowlets, rf, fitCanvas]);

    // `onInspect` backs the run-data chip: it opens the SOURCE step's full
    // view, which is where the rows behind "201 records" actually are.
    const edgesWithControls = useMemo(() => {
        const inspect = onNodeExpand || onNodeClick || null;
        if (!allowEdgeEdits) {
            return inspect ? edges.map(e => ({ ...e, data: { ...(e.data || {}), onInspect: inspect } })) : edges;
        }
        return edges.map((e) => {
            // A line inside an expanded loop is derived from the body's order,
            // not stored: "+" means "put a step here", which IS an order edit,
            // but there is nothing to delete or recolour — the next render
            // would draw the link straight back. Offering the controls anyway
            // would be offering two buttons that quietly do nothing.
            const derived = inLoopBody(e.source);
            return {
                ...e,
                data: {
                    ...(e.data || {}),
                    editable: true,
                    onInsert: onEdgeInsertClick,
                    onDelete: derived ? null : onEdgeDeleteClick,
                    onSetColor: derived ? null : onEdgeSetColor,
                    onInspect: inspect,
                },
            };
        });
    }, [edges, allowEdgeEdits, onEdgeInsertClick, onEdgeDeleteClick, onEdgeSetColor, onNodeExpand, onNodeClick, inLoopBody]);

    // Drop-target accent: the hovered connection thickens in the accent colour
    // ("release here and I'll splice the step in"); the hovered node gets an
    // outline ("release here and I'll wire it after this step").
    // Both gestures share one highlight language: dragging a step in from the
    // ribbon, and dragging a loose node around the canvas.
    const dropHighlightEdgeId = dropTarget?.kind === 'edge' ? dropTarget.id
        : nodeDropTarget?.kind === 'edge' ? nodeDropTarget.edgeId : null;
    const dropHighlightNodeId = dropTarget?.kind === 'node' ? dropTarget.id
        : nodeDropTarget?.kind === 'node' ? nodeDropTarget.nodeId : null;
    // ── AI-step tools, as satellite nodes ───────────────────────────────
    //
    // Derived from the LIVE `nodes` (not computedNodes) so a tool follows its
    // AI step while that step is being dragged. Never written to the
    // definition — see flow/aiToolNodes.js for why that is the whole design.
    const toolLabels = useMemo(() => toolLabelIndex(catalog), [catalog]);
    const onDetachTool = useCallback((stepId, tool) => {
        if (!editable || structuralEditsBlocked) return;
        const next = detachTool(definition, stepId, tool);
        if (next === definition) return;
        onDefinitionChange?.(seedPositions(next));
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange]);
    const toolGraph = useMemo(() => buildAiToolGraph(nodes, {
        labelFor: (t) => toolLabels.get(t) || null,
        onDetach: onDetachTool,
        editable: editable && !structuralEditsBlocked,
    }), [nodes, toolLabels, onDetachTool, editable, structuralEditsBlocked]);

    // ── Row gutter labels ────────────────────────────────────────────────
    //
    // "Row 1 · steps 1–5" above every row of a wrapped canvas (design 1a).
    // Derived from the LIVE positions, like the tool satellites, so a row the
    // user drags apart re-labels itself; never written to the definition.
    // rowBands returns [] for a single row, so an unwrapped flow draws none.
    const rowLabelNodes = useMemo(() => {
        const items = [];
        for (const n of nodes || []) {
            if (!n || n.parentId || SYNTHETIC_TYPES[n.type] || n.type === 'note') continue;
            const p = n.position || {};
            const num = stepNumberById?.get?.(n.id);
            items.push({
                id: n.id, x: p.x, y: p.y,
                width: n.width ?? n.measured?.width ?? 240,
                height: n.height ?? n.measured?.height ?? 72,
                number: typeof num === 'number' ? num : undefined,
            });
        }
        return rowBands(items).map(b => ({
            id: `__row__${b.index}`,
            type: 'row_label',
            position: { x: b.left, y: b.top - ROW_LABEL_OFFSET },
            draggable: false,
            selectable: false,
            connectable: false,
            focusable: false,
            deletable: false,
            zIndex: -1,
            data: { index: b.index, first: b.first, last: b.last, synthetic: true },
        }));
    }, [nodes, stepNumberById]);

    const activeToolPortId = dropTarget?.kind === 'toolPort' ? dropTarget.id : null;

    const nodesWithDropTarget = useMemo(() => {
        // The ghost slot rides along with the other synthetic nodes so the
        // wide shot's bounds leave room for what comes next.
        const extras = [...toolGraph.nodes, ...rowLabelNodes, ...(ghostNodes || [])];
        const base = extras.length ? [...nodes, ...extras] : nodes;
        const layered = applySelectionLayering(base);
        const hasFx = !!buildFxById && buildFxById.size > 0;
        if (!dropHighlightNodeId && !activeToolPortId && !hasFx) return layered;
        return layered.map((n) => {
            let out = n;
            // A card still waiting for its turn in a burst is laid out and
            // measured but invisible; Tab must not land on it.
            if (hasFx) {
                const fx = buildFxById.get(n.id);
                if (fx && fx.delayMs > 0 && out.focusable !== false) out = { ...out, focusable: false };
            }
            if (n.id === activeToolPortId) return { ...out, data: { ...(out.data || null), toolPortActive: true } };
            if (n.id === dropHighlightNodeId) {
                return { ...out, style: { ...(out.style || null), outline: '2px solid var(--text-primary)', outlineOffset: '4px', borderRadius: '12px' } };
            }
            return out;
        });
    }, [nodes, toolGraph, rowLabelNodes, ghostNodes, dropHighlightNodeId, activeToolPortId, buildFxById]);

    // Identity colours: what each line MEANS — a manual pick (edge.color),
    // or, per the "Colour lines by" mode, its branch case / the source's
    // dominant PII group. Stamped as both stroke and data.chipColor so the
    // line and its case chip agree.
    // PII group → hex, with this automation's own overrides (Lines panel) folded
    // over the fixed defaults.
    const piiGroupColors = useMemo(() => resolvePiiGroupColors(definition), [definition]);

    const identityColoredEdges = useMemo(() => {
        return edgesWithControls.map((e) => {
            const srcRun = runByStep.get(e.source) || null;
            const color = identityColorForEdge(e.data, edgeColorMode, srcRun, piiGroupColors);
            if (!color) return e;
            // In PII mode, spell out WHAT was detected on the chip tooltip —
            // counts only ("Email ×3"), never values; "approximate" when the
            // scan was partial or regex-grade.
            let piiTooltip = null;
            if (edgeColorMode === 'pii' && srcRun?.piiSummary?.categories) {
                const parts = Object.entries(srcRun.piiSummary.categories).map(([k, n]) => `${k} ×${n}`);
                piiTooltip = `Detected: ${parts.join(', ')}${srcRun.piiSummary.degraded ? ' — approximate' : ''}`;
            }
            return {
                ...e,
                style: { ...(e.style || {}), stroke: color, strokeWidth: 2 },
                data: { ...(e.data || {}), identityColor: color, chipColor: color, ...(piiTooltip ? { piiTooltip } : {}) },
            };
        });
    }, [edgesWithControls, edgeColorMode, runByStep, piiGroupColors]);

    // Build choreography: a connection the AI just added draws in from its
    // source. Matched on the rendered edge's id, which layout.js derives from
    // the definition row with the same `edgeKey` the choreography diff uses
    // (a `#dupN` suffix marks a duplicate row; the key is what comes before
    // it). The delay is the TARGET card's reveal delay, so in a burst each
    // line arrives just ahead of the card it leads to. This pass sits after
    // identity colours and before run decoration on purpose: an edge draws in
    // in its own tone, and a run in flight keeps the last word.
    const freshEdges = useMemo(() => {
        if (!freshEdgeKeys || freshEdgeKeys.size === 0) return identityColoredEdges;
        return identityColoredEdges.map((e) => {
            const key = String(e.id).split('#dup')[0];
            if (!freshEdgeKeys.has(key)) return e;
            const delayMs = buildFxById?.get?.(e.target)?.delayMs || 0;
            return {
                ...e,
                className: e.className ? `${e.className} bf-edge-fresh` : 'bf-edge-fresh',
                data: { ...(e.data || {}), buildFx: { delayMs } },
            };
        });
    }, [identityColoredEdges, freshEdgeKeys, buildFxById]);

    // Run-state decoration on top (flow/edgeColoring.js): error red beats
    // everything; in-flight animates; traversal keeps a custom colour (width
    // bump) and paints uncoloured edges the classic green. runByStep (not
    // runSteps) so a pinned-only graph still decorates — its rows can be
    // synthetic pin stubs with no run behind them.
    const decoratedEdges = useMemo(
        () => decorateRunEdges(freshEdges, { runByStep, runInFlight }),
        [freshEdges, runByStep, runInFlight],
    );

    const renderedEdges = useMemo(() => {
        const withHighlight = !dropHighlightEdgeId ? decoratedEdges : decoratedEdges.map(e => (e.id === dropHighlightEdgeId
            ? { ...e, style: { ...(e.style || null), stroke: 'var(--text-primary)', strokeWidth: 3 } }
            : e));
        // Tool tethers — and the ghost slot's tether — are appended AFTER every
        // run/identity/build decorator: they carry no definition row, so none
        // of those passes have anything to say about them (and decorateRunEdges
        // would animate them mid-run; the fresh pass would draw them in).
        const tethers = [...toolGraph.edges, ...(ghostEdges || [])];
        return tethers.length ? [...withHighlight, ...tethers] : withHighlight;
    }, [decoratedEdges, dropHighlightEdgeId, toolGraph, ghostEdges]);

    return { allowEdgeEdits, handleArrange, nodesWithDropTarget, renderedEdges };
}
