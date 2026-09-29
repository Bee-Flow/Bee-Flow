import { useCallback } from 'react';

import { TOOL_HANDLE_ID, isToolNodeId } from './aiToolNodes';
import { branchFromHandle, edgeKey, matchesEdgeIdentity } from './branchEdges';
import { sameInlineScope } from './inlineFlowlets';
import { seedPositions } from './layout';
import { createsCycle } from '../applyAddNode';
import { applyAutoMapToStep } from '../mapping/autoMapInputs';
import { toast } from '../../../shared/Toast';
import { isTerminalStep } from './terminalSteps';

// Connect / edge-edit callbacks for the diagram canvas. Extracted from
// DiagramPaneInner verbatim: called from the same position, so hook order is
// unchanged and every dependency is threaded through as a prop.
export function useEdgeEditCallbacks({
    definition, editable, structuralEditsBlocked, onDefinitionChange,
    autoMapEnabled, catalog, realOutputById, onAutoMapped, inLoopBody,
    onRequestAddNode, onRequestInsertOnEdge, rf, absPositionOf,
}) {
    const onConnect = useCallback(({ source, target, sourceHandle }) => {
        if (!editable || structuralEditsBlocked) return;
        if (!source || !target || source === target) return;
        // The AI step's tools port carries configuration, not flow. An edge
        // out of it into a step has nowhere to live in the definition, and
        // branchFromHandle would stamp a label the runtime never routes.
        if (sourceHandle === TOOL_HANDLE_ID) return;
        if (isToolNodeId(source) || isToolNodeId(target)) return;
        // A flowlet is a separate graph: an edge from inside one to the flow
        // around it has nowhere to live, and the runtime has no way to follow
        // it. Data crosses that boundary through the flowlet's inputs and its
        // Return step, not through a connection.
        if (!sameInlineScope(source, target)) return;
        // Inside a loop, the lines are drawn FROM the body's order, not the
        // other way round: the runtime rebuilds them per iteration and runs the
        // body top to bottom (engine.js buildLinearEdges). A hand-drawn branch
        // or merge here would be rubbed out by the next render, so say why
        // rather than appearing to accept it.
        if (inLoopBody(source) || inLoopBody(target)) {
            toast.info('Steps inside a loop always run top to bottom. Drag a step onto the line to move it.');
            return;
        }
        // Capture which branch port the edge was dragged from so the runtime
        // routes it correctly. `then`/`else` for a condition; `case:<name>`
        // (incl. `case:default`) for a switch. Plain steps drag from the
        // single default handle (no id) and stay unlabelled.
        const branch = branchFromHandle(sourceHandle);
        // A brancher (condition/switch) routes ONLY along labelled edges — an
        // unlabelled edge out of one draws from the first port but never
        // fires at run time (B5). The branch nodes only expose branch
        // handles, so this is unreachable via normal dragging; it guards the
        // programmatic/stale-handle paths. stop_error edges are dead by
        // definition (B9) — nothing ever runs after a Stop-and-Error.
        const sourceStep = source === definition.trigger?.id
            ? definition.trigger
            : (definition.steps || []).find(s => s.id === source);
        if (sourceStep && (sourceStep.type === 'condition' || sourceStep.type === 'switch') && !branch.label) return;
        if (isTerminalStep(sourceStep)) return;
        // Cycle guard: rebuild adjacency including the proposed edge and
        // check whether `source` is reachable from `target`. If so, the new
        // edge would close a loop — reject.
        const existing = definition.edges || [];
        // Dedupe by source+target+branch so two different branch ports can
        // legitimately route to the same downstream step.
        if (existing.some(e => e.from === source && e.to === target && (e.label || null) === (branch.label || null))) return;
        if (createsCycle(definition, source, target)) return;
        const nextEdges = [...existing, { from: source, to: target, ...branch }];
        // Compute against the def WITH the new edge so the target sees its
        // new upstream source, then auto-map its still-empty inputs.
        let nextDef = seedPositions({ ...definition, edges: nextEdges });
        if (autoMapEnabled && catalog) {
            const { definition: mapped, mappedKeys, forEachEnabled } = applyAutoMapToStep(nextDef, target, catalog, { realOutputById });
            nextDef = mapped;
            if (mappedKeys.length || forEachEnabled) onAutoMapped?.(target, mappedKeys.length, forEachEnabled);
        }
        onDefinitionChange?.(nextDef);
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange, autoMapEnabled, catalog, realOutputById, onAutoMapped, inLoopBody]);

    /**
     * When the user drags a connection handle but releases over the empty
     * pane (no target handle), open the slide-in palette anchored at the
     * drop point so they can pick a follow-up step. The parent will insert
     * BOTH the node AND the source→new edge in one definition update so
     * undo treats it as a single action.
     */
    const onConnectEnd = useCallback((event, connectionState) => {
        if (!editable || structuralEditsBlocked) return;
        if (!onRequestAddNode) return;
        // React Flow v12 connectionState has isValid + fromNode. We only
        // want the "dropped on pane" case — if isValid is true the user hit
        // an existing handle and onConnect already fired.
        if (!connectionState || connectionState.isValid) return;
        const sourceId = connectionState.fromNode?.id;
        if (!sourceId) return;
        // Which branch port the drag started from — so a step created by
        // dropping on empty pane is wired to that branch (then/else/case).
        const sourceHandle = connectionState.fromHandle?.id || null;
        const clientX = event.clientX ?? event.changedTouches?.[0]?.clientX;
        const clientY = event.clientY ?? event.changedTouches?.[0]?.clientY;
        if (clientX == null || clientY == null) return;
        const position = rf.screenToFlowPosition
            ? rf.screenToFlowPosition({ x: clientX, y: clientY })
            : { x: clientX, y: clientY };
        onRequestAddNode({ sourceId, position, sourceHandle });
    }, [editable, structuralEditsBlocked, onRequestAddNode, rf]);

    // Delete-key / marquee edge deletion. React Flow hands us the RENDERED
    // edges, whose data carries the definition row's true identity
    // (layout.js: defLabel/defCaseName). Matching on the full edgeKey removes
    // exactly the selected rows — the bare (source,target) pair used to take
    // every parallel branch edge between the same two nodes with it (B4).
    const onEdgesDelete = useCallback((deleted) => {
        if (!editable || structuralEditsBlocked) return;
        if (!deleted || deleted.length === 0) return;
        const all = definition.edges || [];
        const remove = new Set();
        for (const d of deleted) {
            if (d.data && ('defLabel' in d.data || 'defCaseName' in d.data)) {
                remove.add(edgeKey({ from: d.source, to: d.target, label: d.data.defLabel || undefined, caseName: d.data.defCaseName ?? undefined }));
            } else {
                // Stale render without identity data: only pair-match when it
                // is unambiguous — refuse to over-delete parallel branches.
                const pairRows = all.filter(e => e.from === d.source && e.to === d.target);
                if (pairRows.length === 1) remove.add(edgeKey(pairRows[0]));
            }
        }
        if (remove.size === 0) return;
        const nextEdges = all.filter(e => !remove.has(edgeKey(e)));
        onDefinitionChange?.(seedPositions({ ...definition, edges: nextEdges }));
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange]);

    // "×" button on an edge — remove just that connection. Identity comes
    // from the edge's own data (label/caseName, threaded via edges.jsx); the
    // handle-derived branch remains as fallback for stale renders.
    const onEdgeDeleteClick = useCallback(({ source, target, sourceHandle, label, caseName }) => {
        if (!editable || structuralEditsBlocked || !source || !target) return;
        const identity = (label != null || caseName != null)
            ? { label, caseName }
            : branchFromHandle(sourceHandle || null); // {} | {label} | {label,caseName}
        const hasIdentity = identity.label != null || identity.caseName != null;
        const matchesClicked = (e) => {
            if (e.from !== source || e.to !== target) return false;
            if (!hasIdentity && sourceHandle == null) return true; // plain edge — pair match is enough
            return matchesEdgeIdentity(e, identity);
        };
        const nextEdges = (definition.edges || []).filter(e => !matchesClicked(e));
        onDefinitionChange?.(seedPositions({ ...definition, edges: nextEdges }));
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange]);

    // Palette button on an edge — persist (or clear) the connection's colour.
    // Cosmetic definition data: identity-matched exactly like delete, but no
    // re-layout and no seedPositions (topology is untouched).
    const onEdgeSetColor = useCallback(({ source, target, sourceHandle, label, caseName, color }) => {
        if (!editable || structuralEditsBlocked || !source || !target) return;
        const identity = (label != null || caseName != null)
            ? { label, caseName }
            : branchFromHandle(sourceHandle || null);
        const hasIdentity = identity.label != null || identity.caseName != null;
        const matchesClicked = (e) => {
            if (e.from !== source || e.to !== target) return false;
            if (!hasIdentity && sourceHandle == null) return true;
            return matchesEdgeIdentity(e, identity);
        };
        const nextEdges = (definition.edges || []).map((e) => {
            if (!matchesClicked(e)) return e;
            if (!color) {
                // "auto" — remove the key entirely rather than persisting null.
                const { color: _dropped, ...rest } = e;
                return rest;
            }
            return { ...e, color };
        });
        onDefinitionChange?.({ ...definition, edges: nextEdges });
    }, [definition, editable, structuralEditsBlocked, onDefinitionChange]);

    // "+" button on an edge — insert a step BETWEEN source and target. We
    // hand the parent both ends + a midpoint position so it can open the
    // palette; on pick it splices the new node in (source→new→target) and
    // drops ONLY the clicked edge (identity-matched — B3).
    const onEdgeInsertClick = useCallback(({ source, target, sourceHandle, label, caseName }) => {
        if (!editable || structuralEditsBlocked || !source || !target || !onRequestInsertOnEdge) return;
        // Absolute, not the raw node positions: inside an expanded flowlet
        // those are relative to the container, and the midpoint would land
        // near the canvas origin.
        const a = absPositionOf(rf.getNode?.(source));
        const b = absPositionOf(rf.getNode?.(target));
        const position = (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
        // Thread the branch identity so the spliced-in step keeps routing on
        // the same branch AND the sibling branch edges survive the splice.
        onRequestInsertOnEdge({
            sourceId: source, targetId: target, position,
            sourceHandle: sourceHandle || null,
            label: label ?? null, caseName: caseName ?? null,
        });
    }, [editable, structuralEditsBlocked, onRequestInsertOnEdge, rf, absPositionOf]);

    return { onConnect, onConnectEnd, onEdgesDelete, onEdgeDeleteClick, onEdgeSetColor, onEdgeInsertClick };
}
