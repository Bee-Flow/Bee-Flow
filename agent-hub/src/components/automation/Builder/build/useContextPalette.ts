import { useCallback, useMemo, useState } from 'react';
import type { AddStepOptions, AddStepPayload, Position } from './addStepModel';
import { addOptionsFor, ribbonAnchor } from '../flow/ribbon/ribbonAnchor';
import { itemForKey as itemForKeyJs } from '../flow/stepPalette';
import type { FlowDefinition } from '../flow/types';

// stepPalette.js is JavaScript whose `= {}` default reads as the option bag's whole type.
const itemForKey = itemForKeyJs as (key: string, opts: { catalog: unknown; layers: unknown }) => { payload?: AddStepPayload } | null;

/**
 * The small anchored popover used for context-adds (edge-drop / add-after /
 * insert-on-edge), where a step must land at a specific spot. `position` and
 * `edgeSource` are set only when it was opened from the canvas; both null
 * means "open from FAB or auto-open" and the step goes in at canvas centre.
 */
export interface ContextPalette {
    open: boolean;
    position: Position | null;
    edgeSource: string | null;
    edgeTarget?: string | null;
    edgeSourceHandle?: string | null;
    edgeLabel?: string | null;
    edgeCaseName?: string | null;
}

/**
 * The context popover's state and the canvas gestures that open it. Split out
 * of BuildTab without a change in behaviour.
 */
export function useContextPalette() {
    const [palette, setPalette] = useState<ContextPalette>({ open: false, position: null, edgeSource: null });

    const closePalette = useCallback(() => {
        setPalette({ open: false, position: null, edgeSource: null, edgeTarget: null });
    }, []);

    // An edge dragged into empty space. `edgeSourceHandle` carries the branch
    // port (then/else/case) so the new step is wired to it.
    const onRequestAddNodeFromEdge = useCallback(({ sourceId, position, sourceHandle }: {
        sourceId: string; position: Position | null; sourceHandle?: string | null;
    }) => {
        setPalette({ open: true, position, edgeSource: sourceId, edgeSourceHandle: sourceHandle || null });
    }, []);

    // The n8n-style "+" hover button on each node: the next pick is wired to
    // the clicked node, positioned from the source node's position.
    const onRequestAddAfter = useCallback((nodeId: string | null) => {
        if (!nodeId) return;
        setPalette({ open: true, position: null, edgeSource: nodeId });
    }, []);

    // The "+" button ON an edge: the picked step is spliced BETWEEN its ends.
    // edgeLabel/edgeCaseName carry the clicked DEFINITION edge's identity so
    // the splice removes exactly that edge and re-stamps the branch on
    // source→new; without identity the old pair-based splice dropped every
    // parallel branch edge between the same two nodes (B3).
    const onRequestInsertOnEdge = useCallback(({ sourceId, targetId, position, sourceHandle, label = null, caseName = null }: {
        sourceId: string; targetId: string; position?: Position | null; sourceHandle?: string | null;
        label?: string | null; caseName?: string | null;
    }) => {
        if (!sourceId || !targetId) return;
        setPalette({
            open: true, position: position || null,
            edgeSource: sourceId, edgeTarget: targetId,
            edgeSourceHandle: sourceHandle || null,
            edgeLabel: label ?? null, edgeCaseName: caseName ?? null,
        });
    }, []);

    return { palette, setPalette, closePalette, onRequestAddNodeFromEdge, onRequestAddAfter, onRequestInsertOnEdge };
}

export interface UseAddSurfacesOptions {
    palette: ContextPalette;
    setPalette: (update: (p: ContextPalette) => ContextPalette) => void;
    closePalette: () => void;
    addStepAt: (payload: AddStepPayload | null, opts?: AddStepOptions) => void;
    onRequestAddAfter: (nodeId: string | null) => void;
    catalog: unknown;
    paletteLayers: unknown;
    flatDef: FlowDefinition | null;
    ndvStepId: string | null;
}

/**
 * Every surface that adds a step, each turned into an addStepAt call with its
 * own target. Split out of BuildTab without a change in behaviour.
 */
export function useAddSurfaces({
    palette, setPalette, closePalette, addStepAt, onRequestAddAfter, catalog, paletteLayers, flatDef, ndvStepId,
}: UseAddSurfacesOptions) {
    // The context popover's pick handler. Keep the panel open so the user can
    // add several nodes in a row; a wired insert is single-shot and closes.
    const handleAddNode = useCallback((payload: AddStepPayload | null) => {
        if (!payload) return;
        addStepAt(payload, {
            position: palette.position,
            sourceId: palette.edgeSource,
            targetId: palette.edgeTarget,
            sourceHandle: palette.edgeSourceHandle || null,
            label: palette.edgeLabel ?? null,
            caseName: palette.edgeCaseName ?? null,
        });
        if (palette.edgeSource || payload.kind === 'create_layer') closePalette();
        else setPalette(p => ({ ...p, position: null, edgeSource: null, edgeTarget: null, edgeLabel: null, edgeCaseName: null }));
    }, [addStepAt, palette.position, palette.edgeSource, palette.edgeTarget, palette.edgeSourceHandle, palette.edgeLabel, palette.edgeCaseName, closePalette, setPalette]);

    // A step dragged onto the canvas from the ribbon / add-step menu. The
    // canvas already resolved WHERE it landed (a connection → splice, a node →
    // append after it, empty canvas → unconnected).
    const handleDropStep = useCallback((payload: AddStepPayload, target: AddStepOptions = {}) => {
        addStepAt(payload, target);
    }, [addStepAt]);

    // The step drawer's "what next?" buttons under an unused output: a loop
    // or a datatable lands straight after the step; anything else opens the
    // add-after popover like the node's own "+".
    const onAddAfterStep = useCallback((stepId: string, suggestion: string | null = null) => {
        const item = suggestion ? itemForKey(`step:${suggestion}`, { catalog, layers: paletteLayers }) : null;
        if (item?.payload && stepId) addStepAt(item.payload, { sourceId: stepId });
        else onRequestAddAfter(stepId);
    }, [addStepAt, onRequestAddAfter, catalog, paletteLayers]);

    // Where a ribbon click lands (design 5a, "Adds after [step n · label]"):
    // after the step open in the drawer, else after the last step.
    const ribbonAnchorStep = useMemo(() => ribbonAnchor(flatDef, ndvStepId || null), [flatDef, ndvStepId]);
    const handleRibbonAdd = useCallback((payload: AddStepPayload | null) => {
        if (!payload) return;
        addStepAt(payload, addOptionsFor(flatDef, ribbonAnchorStep));
    }, [addStepAt, flatDef, ribbonAnchorStep]);

    return { handleAddNode, handleDropStep, onAddAfterStep, ribbonAnchorStep, handleRibbonAdd };
}
