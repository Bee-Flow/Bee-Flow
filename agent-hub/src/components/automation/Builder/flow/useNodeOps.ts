import { useCallback, useLayoutEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { prefixAddedStep, parseInlineId } from './inlineFlowlets';
import { seedPositions } from './layout';
import { applyDeleteNodes, applyDuplicateNode, applyDetachNode, applyPatchStep } from './nodeOps';
import type { FlowDefinition } from './types';
import type { RealOutputMap } from '@/hooks/useUpstreamVariables';
import type { DefinitionEmitter, DiagramDefinition, DiagramStep, RunByStep, StepId } from './diagramPaneTypes';

/** The inputs the node operations read at call time (also read by useNodeDragWiring). */
export interface NodeOpsInputs {
    definition: DiagramDefinition;
    editable: boolean;
    structuralEditsBlocked: boolean;
    onDefinitionChange: DefinitionEmitter;
    catalog: unknown;
    realOutputById: RealOutputMap | null | undefined;
    autoMapEnabled: boolean;
    onAutoMapped: ((stepId: string, mappedCount: number, forEachEnabled: boolean) => void) | null | undefined;
    inlineTriggerIds: Set<StepId>;
}

export interface NodeOps {
    nodeOpsRef: MutableRefObject<NodeOpsInputs>;
    onDeleteNode: (stepId: StepId) => void;
    onDetachNode: (stepId: StepId) => void;
    onDuplicateNode: (stepId: StepId) => void;
    onPatchStep: (stepId: StepId, patch: Record<string, unknown>) => void;
    onPinNode: (stepId: StepId) => void;
}

/**
 * Per-node delete / duplicate. Reached from the node's hover chrome, the
 * canvas context menu, and the node detail view — three surfaces, one pair
 * of handlers (BFSF-319). DiagramPane publishes them to every node component
 * through NodeRuntimeContext.
 *
 * Read their inputs through a ref so the callbacks keep a STABLE identity.
 * `onDefinitionChange` is BuilderShell's `onVisualEdit`, whose useCallback
 * depends on the draft-history object — recreated every render — so a
 * normal dep array would churn `runtimeContextValue` on every render and
 * re-render all 23 node components each time.
 */
export function useNodeOps(inputs: NodeOpsInputs, runByStep: RunByStep): NodeOps {
    // The node callbacks read the latest inputs when they fire; synced after each commit.
    const nodeOpsRef = useRef<NodeOpsInputs>(inputs);
    useLayoutEffect(() => { nodeOpsRef.current = inputs; });

    const onDeleteNode = useCallback((stepId: StepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit, inlineTriggerIds: protectedIds } = nodeOpsRef.current!;
        if (!ed || blocked || !stepId) return;
        // The layer_input of an expanded flowlet: its mini-definition requires
        // exactly one, so there is nothing sensible to do here.
        if (protectedIds?.has?.(stepId)) return;
        const next = applyDeleteNodes(def as FlowDefinition, stepId);
        if (next === def) return; // primary trigger / unknown id
        emit?.(seedPositions(next));
    }, []);

    // "Remove it from the connection" — unwire the step but keep it. The
    // definition it emits already carries the parked position, so this must NOT
    // go through a re-layout; seedPositions leaves set positions alone.
    const onDetachNode = useCallback((stepId: StepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current!;
        if (!ed || blocked || !stepId) return;
        const next = applyDetachNode(def as FlowDefinition, stepId);
        if (next === def) return; // not a step, or already loose
        emit?.(seedPositions(next));
    }, []);

    const onDuplicateNode = useCallback((stepId: StepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current!;
        if (!ed || blocked || !stepId) return;
        const { definition: next, newStepId } = applyDuplicateNode(def as FlowDefinition, stepId);
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
    const onPatchStep = useCallback((stepId: StepId, patch: Record<string, unknown>) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current!;
        if (!ed || blocked || !stepId) return;
        const next = applyPatchStep(def as FlowDefinition, stepId, patch);
        if (next === def) return;
        emit?.(next as DiagramDefinition);
    }, []);

    // Freeze / release a step's last output from the card (the redesign's
    // fifth action). Writes exactly the patch NodeDetailView's Pin button
    // writes, so the two cannot drift: pinnedSource stays undefined on both
    // paths — only the Edit-output editor sets it to 'edited'.
    // The pin reads the run's rows when it is clicked, through a ref synced after each commit.
    const runByStepRef = useRef(runByStep);
    useLayoutEffect(() => { runByStepRef.current = runByStep; });
    const onPinNode = useCallback((stepId: StepId) => {
        const { definition: def, editable: ed, structuralEditsBlocked: blocked, onDefinitionChange: emit } = nodeOpsRef.current!;
        if (!ed || blocked || !stepId) return;
        const all = [def?.trigger, ...(def?.triggers || []), ...(def?.steps || [])].filter(Boolean) as DiagramStep[];
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
        const next = applyPatchStep(def as FlowDefinition, stepId, patch);
        if (next === def) return;
        emit?.(next as DiagramDefinition);
    }, []);

    return { nodeOpsRef, onDeleteNode, onDetachNode, onDuplicateNode, onPatchStep, onPinNode };
}
