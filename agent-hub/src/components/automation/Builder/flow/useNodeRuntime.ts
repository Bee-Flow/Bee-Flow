import { useMemo } from 'react';
import { buildRuntimeContext } from './buildRuntimeContext';
import { useNodeOps } from './useNodeOps';

type NodeOpsInput = Parameters<typeof useNodeOps>[0];
type NodeOpsRunByStep = Parameters<typeof useNodeOps>[1];
type RuntimeInputs = Parameters<typeof buildRuntimeContext>[0];

type NodeRuntimeArgs = NodeOpsInput & Omit<RuntimeInputs,
    'onPinNode' | 'onDeleteNode' | 'onDuplicateNode' | 'onDetachNode' | 'onPatchStep' | 'runByStep'> & {
    runByStep: NodeOpsRunByStep & RuntimeInputs['runByStep'];
};

/**
 * Per-node delete / duplicate / detach / patch / pin (flow/useNodeOps.ts),
 * and the runtime context every node component reads: which steps are pinned /
 * disabled / mid-run, card identity and node actions (flow/buildRuntimeContext.ts).
 *
 * Reached from the node's hover chrome, the canvas context menu, and the node
 * detail view (BFSF-319); stable identities, inputs read through a ref. The
 * build-choreography flags join the context afterwards (useBuildFilm), once the
 * hook that owns them has run — they need the laid-out nodes this memo runs before.
 */
export function useNodeRuntime(args: NodeRuntimeArgs) {
    const {
        definition, runSteps, runByStep, inlineTriggerIds, inlineExpandedIds, inLoopBody,
        editingStepId, editable, structuralEditsBlocked, onExecuteStep, executingStepId, runInFlight,
        onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, layerRefCounts,
    } = args;
    const {
        nodeOpsRef, onDeleteNode, onDetachNode, onDuplicateNode, onPatchStep, onPinNode,
    } = useNodeOps(args, runByStep);

    const baseRuntimeContext = useMemo(() => buildRuntimeContext({
        definition, runSteps, runByStep, inlineTriggerIds, inlineExpandedIds, inLoopBody,
        editingStepId, editable, structuralEditsBlocked, onExecuteStep, executingStepId, runInFlight,
        onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, layerRefCounts,
        onPinNode, onDeleteNode, onDuplicateNode, onDetachNode, onPatchStep,
    }), [definition, runSteps, runByStep, onExecuteStep, executingStepId, runInFlight, editable, structuralEditsBlocked, onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, layerRefCounts, onPatchStep, onPinNode, editingStepId, onDeleteNode, onDuplicateNode, onDetachNode]);

    return { nodeOpsRef, onDeleteNode, onDetachNode, onDuplicateNode, onPatchStep, onPinNode, baseRuntimeContext };
}
