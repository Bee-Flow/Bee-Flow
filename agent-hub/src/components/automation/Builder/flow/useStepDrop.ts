import { useCallback, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { Edge, Node as FlowNode, XYPosition } from '@xyflow/react';

import { attachTool, allCatalogToolNames, isToolNodeId, parseToolNodeId } from './aiToolNodes';
import { isInlineId, parseInlineId } from './inlineFlowlets';
import { seedPositions } from './layout';
import { readStepPayload, dropTargetFromPoint, sameDropTarget } from './stepDrag';
import { applyAddNode } from '../applyAddNode';
import { isTerminalStep } from './terminalSteps';
import type { DropTarget, StepDragPayload } from './stepDrag';
import type { DiagramDefinition, DiagramStep, Rf, Sidecar } from './diagramPaneTypes';

/** Where a dropped step is wired: after `sourceId`, or into the edge sourceId→targetId. */
interface DropWiring {
    sourceId: string;
    targetId: string | null;
    label: string | null;
    caseName: string | null;
}

/** A rendered edge as layout.js builds it: the definition row's identity rides in `data`. */
type RenderedEdge = Edge<{ defLabel?: string | null; defCaseName?: string | null }>;

interface StepDropArgs {
    editable?: boolean;
    structuralEditsBlocked?: boolean;
    definition: DiagramDefinition;
    edges: RenderedEdge[];
    onDropStep?: ((payload: StepDragPayload, opts: { position: XYPosition; scopePrefix: string } & Partial<DropWiring>) => void) | null;
    onDefinitionChange?: ((next: DiagramDefinition) => void) | null;
    onStepAdded?: ((payload: StepDragPayload, sourceStep: null) => void) | null;
    rf: Rf;
    scopeAtPoint: (point: XYPosition) => string;
    catalog?: unknown;
    wrapperRef: RefObject<HTMLElement | null>;
    onNodeExpand?: ((id: string) => void) | null;
    onOpenLayer?: ((layerKey: string) => void) | null;
    hasInline?: boolean;
    sidecar: Sidecar | null;
}

// ── Drag a step in from the ribbon / add-step menu ───────────────────
//
// The drop is position-aware: hovering a CONNECTION splices the step into
// it, hovering a NODE wires it from that node, and empty canvas leaves it
// loose. `dropTarget` drives the live highlight so the user can see which
// of the three they're about to get BEFORE releasing.
//
// Extracted from DiagramPaneInner verbatim: called from the same position,
// so hook order and state ownership (the parent's fiber) are unchanged.
export function useStepDrop({
    editable, structuralEditsBlocked, definition, edges,
    onDropStep, onDefinitionChange, onStepAdded, rf, scopeAtPoint, catalog,
    wrapperRef, onNodeExpand, onOpenLayer, hasInline, sidecar,
}: StepDropArgs) {
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null); // {kind:'edge'|'node'|'pane', id?}

    const onDragOver = useCallback((event: ReactDragEvent) => {
        if (!editable || structuralEditsBlocked) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        const hit = dropTargetFromPoint(event.clientX, event.clientY);
        setDropTarget((prev: DropTarget | null) => (sameDropTarget(prev, hit) ? prev : hit));
    }, [editable, structuralEditsBlocked]);

    // Leaving the canvas entirely clears the highlight; moving between the
    // canvas's own children fires dragleave too, so ignore those.
    const onDragLeave = useCallback((event: ReactDragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget(null);
    }, []);

    /**
     * Double-click drills into a flowlet's canvas, and on any other node means
     * "show me everything" — the full Input|Parameters|Output editor, where a
     * single click opens only the settings the step needs.
     * (zoomOnDoubleClick is disabled on the editable canvas below so the
     * gesture doesn't also zoom.)
     */
    const onNodeDoubleClick = useCallback((_evt: ReactMouseEvent, node: FlowNode) => {
        if (!node?.id) return;
        // The row labels and the build's ghost slot are canvas furniture with
        // no step behind them; React Flow still wraps them in a clickable
        // node, so the gesture has to be dropped here rather than answered
        // with "editing is paused" for a card that never existed.
        if (node.data?.synthetic) return;
        // A tool chip has no editor of its own; open the AI step that owns it.
        if (isToolNodeId(node.id)) { onNodeExpand?.((parseToolNodeId(node.id) as { stepId: string }).stepId); return; }
        const step = (definition?.steps || []).find((s: DiagramStep) => s.id === node.id);
        // A note (BFSF-411) has no settings panel — double-click edits its
        // text INLINE on the card itself (NoteNode's own handler, which
        // stops propagation before this ever fires in the normal case; this
        // is the fallback for anywhere that gesture doesn't intercept it).
        if (step?.type === 'note') return;
        if (step?.type === 'call_layer' && step.layerKey && onOpenLayer) { onOpenLayer(step.layerKey); return; }
        // Double-clicking something drawn INSIDE an expanded flowlet means
        // "take me to this flowlet" — the same gesture, one level down.
        if (hasInline && isInlineId(node.id) && onOpenLayer) {
            const owner = (sidecar as Sidecar).get(parseInlineId(node.id).prefix);
            if (owner?.layerKey) { onOpenLayer(owner.layerKey as string); return; }
        }
        onNodeExpand?.(node.id);
    }, [definition, onOpenLayer, onNodeExpand, hasInline, sidecar]);

    const onDrop = useCallback((event: ReactDragEvent) => {
        setDropTarget(null);
        if (!editable || structuralEditsBlocked) return;
        event.preventDefault();
        const payload = readStepPayload(event.dataTransfer);
        if (!payload) return;

        const bounds = wrapperRef.current?.getBoundingClientRect();
        const point = rf.screenToFlowPosition
            ? rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            : { x: event.clientX - (bounds?.left || 0), y: event.clientY - (bounds?.top || 0) };

        // Where did it land? Re-hit-test on drop rather than trusting the last
        // dragover — a fast release can outrun the final dragover tick.
        let hit: DropTarget = dropTargetFromPoint(event.clientX, event.clientY);

        // An app released on an AI step's tools port — or on one of the tool
        // chips already hanging there — becomes a TOOL of that step rather than
        // a step of its own.
        const toolTargetId = hit.kind === 'toolPort'
            ? hit.id
            : (hit.kind === 'node' && isToolNodeId(hit.id) ? (parseToolNodeId(hit.id) as { stepId: string }).stepId : null);
        if (toolTargetId) {
            if (payload.kind === 'integration_action' && payload.tool) {
                const next = attachTool(definition, toolTargetId, payload.tool, {
                    allToolNames: allCatalogToolNames(catalog),
                });
                // Unchanged = the step already had this tool. Nothing to do,
                // and adding a duplicate step instead would be a surprise.
                if (next !== definition) {
                    onDefinitionChange?.(seedPositions(next));
                    onStepAdded?.(payload, null);
                }
                return;
            }
            // Not an app: a Loop is not a tool. Fall through as if the AI step
            // itself had been the target, so the gesture still adds the step
            // after it rather than silently doing nothing.
            hit = { kind: 'node', id: toolTargetId };
        }
        // …and in WHICH graph. Dropping inside an expanded flowlet adds the
        // step to that flowlet; wiring is only offered to nodes/edges of the
        // same graph, since a connection can't cross the boundary.
        const scopePrefix = scopeAtPoint(point);
        const inScope = (id?: string | null) => parseInlineId(id || '').prefix === scopePrefix;
        // "Wiring from here would draw a line that never fires" — two
        // different reasons under one name: a brancher routes ONLY on labelled
        // edges, and a TERMINAL step ends the run. The terminal half comes from
        // the shared list so a new end-step cannot be half-known here.
        const isBrancher = (id: string) => {
            const s = (definition.steps || []).find((x: DiagramStep) => x.id === id);
            return s?.type === 'condition' || s?.type === 'switch' || isTerminalStep(s);
        };
        let wiring: DropWiring | null = null;
        if (hit.kind === 'edge') {
            const hovered = edges.find((e: RenderedEdge) => e.id === hit.id);
            if (hovered && inScope(hovered.source)) {
                wiring = {
                    sourceId: hovered.source,
                    targetId: hovered.target,
                    label: hovered.data?.defLabel ?? null,
                    caseName: hovered.data?.defCaseName ?? null,
                };
            }
        } else if (hit.kind === 'node' && hit.id !== payload.id && inScope(hit.id)) {
            // Append after the node — the same wiring the node's "+" produces.
            // A brancher routes ONLY on labelled edges, and Stop-and-Error ends
            // the run: wiring from either would draw a connection that never
            // fires (B5/B9), so those drops add the step unconnected and the
            // user drags from the branch port they mean.
            if (!isBrancher(hit.id as string)) wiring = { sourceId: hit.id as string, targetId: null, label: null, caseName: null };
        }

        // Preferred path: hand the payload + wiring to the parent, which owns
        // auto-map, usage telemetry and the create-flowlet meta-action.
        if (onDropStep) {
            onDropStep(payload, { position: point, scopePrefix, ...(wiring || {}) });
            return;
        }
        // Fallback (callers that don't pass onDropStep): plain unconnected add.
        // applyAddNode normalizes its base internally (BFSF-318), so a
        // degraded `definition` can't produce a shapeless graph here either.
        onDefinitionChange?.(applyAddNode(definition, payload, point));
        onStepAdded?.(payload, null);
    }, [editable, structuralEditsBlocked, definition, edges, onDropStep, onDefinitionChange, onStepAdded, rf, scopeAtPoint, catalog, wrapperRef]);

    return { dropTarget, onDragOver, onDragLeave, onNodeDoubleClick, onDrop };
}
