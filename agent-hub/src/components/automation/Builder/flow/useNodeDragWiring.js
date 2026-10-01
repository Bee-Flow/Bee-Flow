import { useCallback, useRef, useState } from 'react';

import { spliceStepIntoEdge } from './branchEdges';
import { fromDisplayPosition, sameInlineScope } from './inlineFlowlets';
import { seedPositions } from './layout';
import { findNodeDropTarget, sameNodeDropTarget } from './nodeDropTarget';
import { isRouteStep, routePorts } from './routeModel';
import { applyAutoMapToStep } from '../mapping/autoMapInputs';

// ── Drag a node next to something to wire it up ──────────────────────
//
// While a LOOSE node is dragged, the connection or node it would attach to
// lights up and a hint follows the cursor, so "if I let go now, this
// happens" is visible before the drop. Repositioning a node that already
// has connections is left alone — see flow/nodeDropTarget.js.
//
// Extracted from DiagramPaneInner verbatim: called from the same position,
// so hook order and state ownership (the parent's fiber) are unchanged.
export function useNodeDragWiring({
    editable, structuralEditsBlocked, rf, edges, definition,
    hasInline, sidecar, shiftById, wrapperRef, nodeOpsRef, onDefinitionChange,
}) {
    const [nodeDropTarget, setNodeDropTarget] = useState(null);
    const [dropHintPos, setDropHintPos] = useState(null);
    const pendingConnectRef = useRef(null);

    /** Apply a pending drop-target wiring to a definition. */
    const applyPendingConnect = useCallback((def, draggedId) => {
        const hit = pendingConnectRef.current;
        pendingConnectRef.current = null;
        if (!hit) return def;
        const dragged = (def.steps || []).find(s => s.id === draggedId)
            || (def.triggers || []).find(t => t.id === draggedId)
            || (def.trigger?.id === draggedId ? def.trigger : null);
        const firstPort = isRouteStep(dragged) ? routePorts(dragged)[0] : null;
        let wired;
        let downstreamId;
        if (hit.kind === 'edge') {
            const identity = { label: hit.label, caseName: hit.caseName };
            wired = { ...def, edges: spliceStepIntoEdge(def.edges || [], draggedId, hit.sourceId, hit.targetId, identity, firstPort) };
            downstreamId = draggedId; // the dragged node was spliced into the edge
        } else {
            // Chaining onto a node: a brancher's continuation must leave by a
            // real port, or the runtime never follows it (B5).
            const source = hit.from === draggedId ? dragged : ((def.steps || []).find(s => s.id === hit.from) || null);
            const port = isRouteStep(source) ? routePorts(source)[0] : null;
            const branch = {};
            if (port?.label) branch.label = port.label;
            if (port?.caseName != null) branch.caseName = port.caseName;
            wired = { ...def, edges: [...(def.edges || []), { from: hit.from, to: hit.to, ...branch }] };
            downstreamId = hit.to;
        }
        // Drag-to-wire used to be the ONE connect surface that never
        // auto-mapped — a loose node dropped next to a data-bearing node got
        // wired but stayed unconfigured. Same recipe as onConnect below.
        const { catalog: cat, realOutputById: real, autoMapEnabled: am, onAutoMapped: notify } = nodeOpsRef.current;
        if (am && cat && downstreamId) {
            const { definition: mapped, mappedKeys } = applyAutoMapToStep(wired, downstreamId, cat, { realOutputById: real });
            if (mappedKeys.length) {
                notify?.(downstreamId, mappedKeys.length);
                return mapped;
            }
        }
        return wired;
    }, []);

    const onNodeDrag = useCallback((event, node) => {
        if (!editable || structuralEditsBlocked) return;
        // Only offer to wire the dragged node to things in ITS graph — a node
        // inside an expanded flowlet can't connect to the flow around it.
        const candidates = (rf.getNodes ? rf.getNodes() : [])
            .filter(n => sameInlineScope(n.id, node.id));
        const hit = findNodeDropTarget({
            draggedId: node.id,
            nodes: candidates,
            renderedEdges: hasInline ? edges.filter(e => sameInlineScope(e.source, node.id)) : edges,
            definition,
        });
        setNodeDropTarget(prev => (sameNodeDropTarget(prev, hit) ? prev : hit));
        if (!hit) { setDropHintPos(null); return; }
        const bounds = wrapperRef.current?.getBoundingClientRect();
        if (bounds) setDropHintPos({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    }, [editable, structuralEditsBlocked, rf, edges, definition, hasInline]);

    /**
     * Release: hand the wiring to commitNodePositions so the new position and
     * the new connection land in ONE definition update — two separate writes
     * from the same closure would clobber each other.
     *
     * React Flow emits the drag-stop position change and this callback in an
     * order we don't control, so if the position commit already went out
     * (leaving the ref unconsumed) we write the connection ourselves on the
     * next tick. Either order ends with both applied, exactly once.
     */
    const onNodeDragStop = useCallback((_event, node) => {
        const hit = nodeDropTarget;
        setNodeDropTarget(null);
        setDropHintPos(null);
        if (!hit || !editable || structuralEditsBlocked) return;
        pendingConnectRef.current = hit;
        setTimeout(() => {
            if (!pendingConnectRef.current) return;   // commitNodePositions took it
            const { definition: def, onDefinitionChange: emit } = nodeOpsRef.current;
            emit?.(seedPositions(applyPendingConnect(def, node?.id)));
        }, 0);
    }, [nodeDropTarget, editable, structuralEditsBlocked, applyPendingConnect]);

    const commitNodePositions = useCallback((changes) => {
        // Pick out position changes that finished (drag-stop emits one with
        // `dragging: false`). Live-drag changes don't need to round-trip
        // through the definition — ReactFlow handles the in-flight ghost
        // itself, and writing back on every pixel move would thrash the
        // SSE/debounced save.
        const finished = changes.filter(c => c.type === 'position' && c.dragging === false && c.position);
        if (finished.length === 0) return;
        // React Flow hands back DISPLAY coordinates: a node inside an expanded
        // flowlet is positioned relative to its container, and a node the
        // container pushed aside carries that shift. Storing either verbatim
        // would walk the graph across the canvas every time a flowlet is
        // expanded and collapsed.
        const byId = new Map(finished.map(c => [
            c.id,
            hasInline ? fromDisplayPosition(c.id, c.position, sidecar, shiftById) : c.position,
        ]));
        const apply = (s) => byId.has(s.id) ? { ...s, position: byId.get(s.id) } : s;
        // Mirror seedPositions' own shape: triggers[] (secondary triggers)
        // must be rebuilt too — dragging one used to write a definition that
        // simply omitted the move, so the node snapped back on the next
        // layout pass (B6).
        const moved = {
            ...definition,
            trigger: apply(definition.trigger),
            ...(Array.isArray(definition.triggers) ? { triggers: definition.triggers.map(apply) } : {}),
            steps: (definition.steps || []).map(apply),
        };
        // A node dropped next to a connection/node also gets WIRED here, in the
        // same commit as its position — one definition update, one undo entry.
        const next = seedPositions(applyPendingConnect(moved, finished[0]?.id));
        onDefinitionChange?.(next);
    }, [definition, onDefinitionChange, applyPendingConnect, hasInline, sidecar, shiftById]);

    return { nodeDropTarget, dropHintPos, onNodeDrag, onNodeDragStop, commitNodePositions };
}
