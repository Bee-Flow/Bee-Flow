import { useStore } from '@xyflow/react';
import { useNodeRuntime } from '../NodeRuntimeContext';
import type { NodeRuntime, StepIssues } from './StepNodeBase.types';

interface Args {
    nodeId: string | null;
    issues: StepIssues | undefined;
    familyProp: string | null;
    stepTypeProp: string | null;
}

/**
 * What the card derives from NodeRuntimeContext and React Flow's own store, so
 * the 36 node files never have to pass it: pins, run position, family, step
 * number, editing state and which action buttons apply.
 */
export function useStepNodeRuntime({ nodeId, issues, familyProp, stepTypeProp }: Args) {
    const rt = useNodeRuntime() as NodeRuntime;
    const pinned = nodeId ? rt.pinnedById?.has?.(nodeId) : false;
    const disabled = nodeId ? rt.disabledById?.has?.(nodeId) : false;
    const customIconName = nodeId ? rt.customIconById?.get?.(nodeId) : null;
    const executingThis = !!nodeId && rt.executingStepId === nodeId;
    const runInFlight = !!rt.runInFlight;
    const runIndex = nodeId ? rt.runIndexById?.get?.(nodeId) : null;
    const runTotal = rt.runTotal ?? null;
    const highlighted = !!nodeId && rt.highlightedStepId === nodeId;
    const errCount = issues?.errors?.length || 0;
    const warnCount = issues?.warnings?.length || 0;

    // The family and the step number — computed once per canvas in
    // DiagramPane's runtime context, so no node file has to pass them.
    const family = familyProp || (nodeId ? rt.typeGroupById?.get?.(nodeId) : null) || null;
    const stepType = stepTypeProp || (nodeId ? rt.stepTypeById?.get?.(nodeId) : null) || null;
    const stepNumber = nodeId ? rt.stepNumberById?.get?.(nodeId) : null;

    // Selection straight from React Flow's store: a boolean selector, so the
    // card re-renders only when ITS selection flips — not on every pan, and
    // not on every other node's selection. No prop, no context, no node-file
    // change needed.
    const selected = useStore((s) => !!(nodeId && s.nodeLookup?.get?.(nodeId)?.selected));
    // The author's own step names, read from the same store for the same
    // reason: flow/layout.js already puts `stepLabelById` (buildStepLabelMap —
    // the very map the canvas validation pill humanises with) on every node's
    // data, so the card can pick it up without all 36 node files threading one
    // more prop through to here.
    const stepLabelById = useStore((s) => (nodeId ? s.nodeLookup?.get?.(nodeId)?.data?.stepLabelById as Map<string, string> | null | undefined : null) || null);
    // While the drawer edits a step (design 1h): the edited card reads as
    // selected, its direct source is drawn dashed in the family colour with
    // "· source" in the kicker, and what comes next is dimmed.
    const editing = !!nodeId && rt.editingStepId === nodeId;
    const isSource = nodeId ? !!rt.editingSourceIds?.has?.(nodeId) : false;
    const isTarget = nodeId ? !!rt.editingTargetIds?.has?.(nodeId) : false;

    const isPrimaryTrigger = !!nodeId && rt.primaryTriggerId === nodeId;
    const isAnyTrigger = nodeId ? !!rt.triggerIds?.has?.(nodeId) : false;
    const showDelete = !!rt.onDeleteNode && !!nodeId && !isPrimaryTrigger && !rt.undeletableIds?.has?.(nodeId);
    const showDuplicate = !!rt.onDuplicateNode && !!nodeId && !isAnyTrigger;
    const showDetach = !!rt.onDetachNode && !!nodeId && !isAnyTrigger && !!rt.attachedIds?.has?.(nodeId);
    // Pin needs a captured output to freeze (or an existing pin to release).
    // A trigger never has a run row, so it never gets the button.
    const pinnable = nodeId ? !!rt.pinnableIds?.has?.(nodeId) : false;
    const showPin = !!rt.onPinNode && !!nodeId && !isAnyTrigger && (pinnable || !!pinned);

    return {
        rt, pinned, disabled, customIconName, executingThis, runInFlight, runIndex, runTotal, highlighted, errCount, warnCount,
        family, stepType, stepNumber, selected, stepLabelById, editing, isSource, isTarget,
        showDelete, showDuplicate, showDetach, showPin,
    };
}
