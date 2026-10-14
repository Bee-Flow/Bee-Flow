import { followSuccessors } from '@shared/expr/routeFollow.mjs';
import { useCallback } from 'react';
import { toast } from '../../../shared/Toast';
import { decomposeInlineGraph as decomposeInlineGraphJs, parseInlineId, prefixAddedStep } from '../flow/inlineFlowlets';
import { applyDeleteNodes as applyDeleteNodesJs, applyDuplicateNode } from '../flow/nodeOps';
import { renameFormField as renameFormFieldJs } from '../flow/renameFormField';
import { followedMessages } from '../flow/routeFollowNotes';
import type { Rebound } from '../flow/routeFollowNotes';
import { insertStepBefore } from '../flow/settings/routeHandoff';
import type { FlowDefinition, FlowStep } from '../flow/types';
import type { TranslateFn } from '../../../../hooks/useTranslation';

// The JavaScript graph transforms, with the definition type this folder speaks.
const renameFormField = renameFormFieldJs as (
    definition: FlowDefinition | null, change: { base: string; from: string; to: string },
) => { ok: boolean; definition: FlowDefinition; rewritten?: number };
const applyDeleteNodes = applyDeleteNodesJs as (definition: FlowDefinition, ids: string) => FlowDefinition;
const decomposeInlineGraph = decomposeInlineGraphJs as (flatGraph: FlowDefinition, sidecar: Map<string, object>) => {
    graph: FlowDefinition; layerPatches: Record<string, FlowDefinition>;
};

export interface UseStepGraphEditsOptions {
    rootDef: FlowDefinition | null;
    flatDef: FlowDefinition | null;
    running: boolean;
    inlineSidecar: Map<string, object>;
    onVisualEditRoot?: ((def: FlowDefinition) => void) | null;
    onVisualEditFlat?: ((def: FlowDefinition) => void) | null;
    onSaveStep: (graph: FlowDefinition, layerPatches?: Record<string, FlowDefinition>) => unknown;
    t: TranslateFn;
}

/**
 * The graph edits the step drawer (NodeDetailView) asks BuildTab for: they
 * need the level that owns the whole definition, so the panel cannot make
 * them itself. Split out of BuildTab without a change in behaviour.
 */
export default function useStepGraphEdits({
    rootDef, flatDef, running, inlineSidecar, onVisualEditRoot, onVisualEditFlat, onSaveStep, t,
}: UseStepGraphEditsOptions) {
    /**
     * Rename one form question's binding name across the WHOLE automation.
     *
     * A form field's `name` is `trigger.output.<name>` (or
     * `steps.<pageId>.output.<name>`), so renaming it is never a local edit: it
     * has to move every ref, template and expression that pointed at the old
     * one, in flowlet layers included.
     *
     * Returns the number of bindings that moved, which the panel reports back
     * to the author: "12 steps were repointed" and "nothing pointed here yet"
     * must not look the same.
     */
    const onRenameBinding = useCallback((base: string, from: string, to: string) => {
        const out = renameFormField(rootDef, { base, from, to });
        if (!out.ok) return undefined;
        onVisualEditRoot?.(out.definition);
        return out.rewritten;
    }, [rootDef, onVisualEditRoot]);

    /**
     * Put a ready-made step IN FRONT of an existing one and re-point the
     * connections, in one commit — the Condition node's "Suggest outputs" box
     * adds a step that writes the field it needs (flow/settings/routeHandoff.js).
     *
     * The graph edit itself is `insertStepBefore` — pure, and pinned by tests
     * of its own, because every way of getting the rewire wrong is silent.
     * What lands HERE is only what needs the shell: the running lock, the
     * flowlet the target lives in, and the commit.
     */
    const onInsertStepBefore = useCallback((targetId: string, newStep: FlowStep) => {
        if (!flatDef || running) return false;
        const { definition: inserted, ok } = insertStepBefore(flatDef, targetId, newStep) as { definition: FlowDefinition; ok: boolean };
        if (!ok) return false;
        // A step inserted in front of a node inside an expanded flowlet
        // belongs to that flowlet, not to the flow drawn around it — the same
        // move onDuplicateStep makes, for the same reason.
        const { prefix } = parseInlineId(targetId);
        onVisualEditFlat?.(prefix ? prefixAddedStep(inserted, newStep.id, prefix) : inserted);
        return true;
    }, [flatDef, running, onVisualEditFlat]);

    /**
     * "Use what this Condition keeps": the Condition editor's notice about next
     * steps that still read the list the Condition was given (W7). Re-points
     * them at the Condition's output in one commit, so one Undo restores them.
     */
    const onFollowRoute = useCallback((routeId: string, stepIds: string[]) => {
        if (!flatDef || running || !routeId) return;
        const { definition: followed, rebound } = followSuccessors(flatDef, routeId, stepIds) as
            { definition: FlowDefinition; rebound?: Rebound[] };
        if (!rebound?.length) return;
        onVisualEditFlat?.(followed);
        for (const msg of followedMessages(rebound, followed, t)) toast.success(msg);
    }, [flatDef, running, onVisualEditFlat, t]);

    // Node delete / duplicate for the DETAIL VIEW's header buttons (BFSF-319).
    // The canvas's own surfaces go through DiagramPane's copies of these; both
    // call the same pure transforms and write through the same `onVisualEdit`.
    const onDeleteStep = useCallback((stepId: string) => {
        if (!flatDef || running || !stepId) return;
        const next = applyDeleteNodes(flatDef, stepId);
        if (next === flatDef) return; // primary trigger / unknown id
        onVisualEditFlat?.(next);
    }, [flatDef, running, onVisualEditFlat]);

    const onDuplicateStep = useCallback((stepId: string) => {
        if (!flatDef || running || !stepId) return;
        const { definition: next, newStepId } = applyDuplicateNode(flatDef, stepId) as { definition: FlowDefinition; newStepId?: string };
        if (!newStepId) return; // triggers aren't duplicable
        // The copy of a step inside an expanded flowlet belongs to that
        // flowlet, not to the flow around it.
        const { prefix } = parseInlineId(stepId);
        onVisualEditFlat?.(prefix ? prefixAddedStep(next, newStepId, prefix) : next);
    }, [flatDef, running, onVisualEditFlat]);

    /**
     * The inspector saves the whole graph it was handed. When that graph has
     * flowlets folded into it, split them back out first — otherwise a step
     * with a prefixed id would be persisted into the parent flow.
     */
    const onSaveStepFlat = useCallback((nextFlat: FlowDefinition) => {
        if (!inlineSidecar.size) return onSaveStep(nextFlat);
        const { graph, layerPatches } = decomposeInlineGraph(nextFlat, inlineSidecar);
        return onSaveStep(graph, layerPatches);
    }, [inlineSidecar, onSaveStep]);

    return { onRenameBinding, onInsertStepBefore, onFollowRoute, onDeleteStep, onDuplicateStep, onSaveStepFlat };
}
