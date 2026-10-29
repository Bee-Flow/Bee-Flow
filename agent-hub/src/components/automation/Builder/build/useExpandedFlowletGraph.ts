import { useCallback, useMemo } from 'react';
import type { RefObject } from 'react';
import { countLayerRefs, setScopedGraph } from '../flow/flowletScope';
import {
    composeInlineGraph, decomposeInlineGraph, shiftForExpansion, useExpandedFlowlets as useExpandedFlowletsJs,
} from '../flow/inlineFlowlets';
import { seedPositions } from '../flow/layout';
import type { FlowDefinition, FlowStep } from '../flow/types';


type Sidecar = Map<string, any>;

// inlineFlowlets.js is JavaScript whose `= null` defaults read as the parameters' whole type.
const useExpandedFlowlets = useExpandedFlowletsJs as (automationId: string | null, scopeKey?: string | null) => {
    expanded: Set<string>;
    toggle: (prefix: string, layerKey?: string | null, sidecar?: Sidecar | null) => void;
    collapseAll: () => void;
    expandAll: (callSites: Array<{ prefix: string; layerKey: string | null }>) => void;
};

export interface UseExpandedFlowletGraphOptions {
    automation: any;
    state: import('./buildTabTypes').BuilderTabState;
    scopedDef: FlowDefinition | null;
    rootDef: FlowDefinition | null;
    scopeKey: string | null;
    onVisualEdit?: ((def: FlowDefinition) => void) | null;
    onVisualEditRoot?: ((def: FlowDefinition) => void) | null;
    closeNdv?: (() => void) | null;
    diagramRef: RefObject<{ focusStep?: (stepId: string) => void } | null>;
}

/**
 * The flowlets drawn open on BuildTab's canvas: the flat graph with them folded
 * in, the sidecar that says what came from where, and the one write path that
 * splits a canvas edit back out. Split out of BuildTab without a change in
 * behaviour.
 */
export default function useExpandedFlowletGraph({
    automation, state, scopedDef, rootDef, scopeKey, onVisualEdit, onVisualEditRoot, closeNdv, diagramRef,
}: UseExpandedFlowletGraphOptions) {
    // ── Expanded flowlets ───────────────────────────────────────────────────
    //
    // A `call_layer` node can be opened in place so the flowlet it runs is
    // drawn, and edited, inside the flow that uses it. `flatDef` is the canvas
    // graph with those flowlets folded in; `inlineSidecar` says what came from
    // where, and every edit is split back out by `onVisualEditFlat`.
    //
    // When nothing is expanded, `flatDef === scopedDef` and every path below is
    // exactly the one that existed before.
    const inlineFlowlets = useExpandedFlowlets(automation?.id || state.automationId, scopeKey);
    const { graph: flatDef, sidecar: inlineSidecar } = useMemo(
        () => composeInlineGraph(scopedDef, rootDef, inlineFlowlets.expanded, { scopeLayerKey: scopeKey }) as { graph: FlowDefinition; sidecar: Sidecar },
        [scopedDef, rootDef, inlineFlowlets.expanded, scopeKey],
    );
    const inlineShift = useMemo(() => shiftForExpansion(flatDef, inlineSidecar), [flatDef, inlineSidecar]);
    const onToggleInline = useCallback(
        (nodeId: string, layerKey: string | null) => inlineFlowlets.toggle(nodeId, layerKey, inlineSidecar),
        [inlineFlowlets, inlineSidecar],
    );
    /**
     * Open every flowlet on this canvas at once — the Arrange menu's
     * "Open flowlets". Call sites come from THIS scope's own steps, so a
     * flowlet that is only called from somewhere else stays shut.
     */
    /**
     * Fold every flowlet away — what "Compact" and "Wrap to fit" do first.
     * Stored positions are collapsed-space, so tightening a canvas whose
     * containers are drawn expanded would measure one thing and show another.
     */
    const onCollapseAllFlowlets = useCallback(() => {
        inlineFlowlets.collapseAll();
    }, [inlineFlowlets]);

    const onExpandAllFlowlets = useCallback(() => {
        const callSites = (scopedDef?.steps || [])
            .filter((s: FlowStep | null | undefined) => s?.type === 'call_layer' && s.layerKey)
            .map((s: any) => ({ prefix: s.id, layerKey: s.layerKey }));
        if (callSites.length) inlineFlowlets.expandAll(callSites);
    }, [scopedDef, inlineFlowlets]);
    // How many call sites each flowlet has — an expanded container says so,
    // because editing it changes every one of them. (A loop's body belongs to
    // one step and is never shared, so it has no key and no count.)
    const layerRefCounts = useMemo(() => {
        const out: Record<string, number> = {};
        for (const entry of inlineSidecar.values()) {
            if (entry.layerKey) out[entry.layerKey] = countLayerRefs(rootDef, entry.layerKey);
        }
        return out;
    }, [inlineSidecar, rootDef]);

    /**
     * "Edit on canvas", from a Loop's own editor: draw its body inside the node
     * and get out of the way. Expands rather than toggles — the user asked for
     * the canvas, and closing the panel onto an unchanged card would read as a
     * dead button.
     */
    const expandOnCanvas = useCallback((stepId: string) => {
        if (!stepId) return;
        if (!inlineFlowlets.expanded.has(stepId)) inlineFlowlets.toggle(stepId, null, inlineSidecar);
        closeNdv?.();
        diagramRef.current?.focusStep?.(stepId);
    }, [inlineFlowlets, inlineSidecar, closeNdv, diagramRef]);

    /**
     * The one write path for canvas edits. Splits the edited flat graph back
     * into this scope's graph plus one patch per expanded flowlet, and commits
     * the lot as a single whole-document update so it is one undo entry.
     */
    const onVisualEditFlat = useCallback((nextFlat: FlowDefinition) => {
        if (!inlineSidecar.size) { onVisualEdit?.(nextFlat); return; }
        const { graph, layerPatches } = decomposeInlineGraph(nextFlat, inlineSidecar);
        let root: any = setScopedGraph(rootDef, scopeKey, seedPositions(graph));
        if (Object.keys(layerPatches).length) {
            root = { ...root, layers: { ...(root.layers || {}), ...layerPatches } };
        }
        onVisualEditRoot?.(root);
    }, [inlineSidecar, onVisualEdit, onVisualEditRoot, rootDef, scopeKey]);

    return {
        inlineFlowlets, flatDef, inlineSidecar, inlineShift,
        onToggleInline, onCollapseAllFlowlets, onExpandAllFlowlets, layerRefCounts, expandOnCanvas, onVisualEditFlat,
    };
}
