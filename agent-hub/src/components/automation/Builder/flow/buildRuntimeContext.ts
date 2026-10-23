import { flowOrder } from './flowOrder';
import { isInlineId, parseInlineId } from './inlineFlowlets';
import { stepFamily } from './nodeDefs';
import type { DiagramDefinition, DiagramStep, RunByStep, RunRow, StepId } from './diagramPaneTypes';

type StepCallback = (stepId: StepId) => void;

export interface RuntimeContextInputs {
    definition: DiagramDefinition | null | undefined;
    runSteps: RunRow[] | null | undefined;
    runByStep: RunByStep;
    inlineTriggerIds: Set<StepId>;
    inlineExpandedIds: Set<string>;
    inLoopBody: (nodeId: StepId) => boolean;
    editingStepId: StepId | null;
    editable: boolean;
    structuralEditsBlocked: boolean;
    onExecuteStep: ((stepId: StepId, opts?: { mode: string }) => void) | null | undefined;
    executingStepId: StepId | null;
    runInFlight: boolean;
    onOpenLayer: ((layerKey: string) => void) | null | undefined;
    layerSummaries: Record<string, string> | null | undefined;
    highlightedStepId: StepId | null;
    onToggleInline: ((nodeId: StepId, layerKey: string | null) => void) | null | undefined;
    layerRefCounts: Record<string, number>;
    onPinNode: StepCallback;
    onDeleteNode: StepCallback;
    onDuplicateNode: StepCallback;
    onDetachNode: StepCallback;
    onPatchStep: (stepId: StepId, patch: Record<string, unknown>) => void;
}

/**
 * The runtime context every node component reads (NodeRuntimeContext): which
 * steps are pinned / disabled / mid-run, the card identity (family, number),
 * the editing highlights and the node actions. The 17 per-type node
 * components read this via NodeRuntimeContext so their call-sites stay
 * unchanged. DiagramPane memoises it and adds the build-choreography flags.
 */
export function buildRuntimeContext({
    definition, runSteps, runByStep, inlineTriggerIds, inlineExpandedIds, inLoopBody,
    editingStepId, editable, structuralEditsBlocked, onExecuteStep, executingStepId, runInFlight,
    onOpenLayer, layerSummaries, highlightedStepId, onToggleInline, layerRefCounts,
    onPinNode, onDeleteNode, onDuplicateNode, onDetachNode, onPatchStep,
}: RuntimeContextInputs) {
    const pinnedById = new Set<StepId>();
    const disabledById = new Set<StepId>();
    // Custom per-step symbol (a Lucide icon name set in the inspector).
    // StepNodeBase reads this to override the default type icon.
    const customIconById = new Map<StepId, string>();
    const allSteps = [definition?.trigger, ...(definition?.steps || [])].filter(Boolean) as DiagramStep[];
    for (const s of allSteps) {
        if (s.pinnedOutput !== undefined && s.pinnedOutput !== null) pinnedById.add(s.id);
        if (s.disabled) disabledById.add(s.id);
        if (s.icon) customIconById.set(s.id, s.icon);
    }
    // Run ordinal — 1-based by finishedAt — so users can see "3/8" on
    // the currently running node. The node still showing 'running'
    // gets ordinal = (count of completed) + 1. 'pinned' steps count as
    // completed for ordering — they're synthetic but the user wants
    // to see their position in the run.
    const ordered = (runSteps || []).filter(s => s.stepId && (s.status === 'success' || s.status === 'skipped' || s.status === 'pinned'))
        .slice().sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
    const runIndexById = new Map<StepId, number>();
    ordered.forEach((s, i) => runIndexById.set(s.stepId!, i + 1));
    const runningStep = (runSteps || []).find(s => s.status === 'running');
    if (runningStep?.stepId) runIndexById.set(runningStep.stepId, ordered.length + 1);
    const runTotal = allSteps.length - 1; // exclude trigger

    // ── Card identity (builder redesign) ──────────────────────────────
    // The family paints the 4px bar and the tile; the number is the
    // step's place in RUN order — the same sequence the node editor pages
    // through — so "step 7" means the same thing on the canvas and in
    // the editor's header. A step inside an expanded container reads
    // `<container number>·<its place inside>`, matching the design's
    // "13 · 1".
    const everyNode = [definition?.trigger, ...(definition?.triggers || []), ...(definition?.steps || [])].filter(Boolean) as DiagramStep[];
    const triggerIdSet = new Set([
        definition?.trigger?.id,
        ...(definition?.triggers || []).map(t => t?.id),
        ...inlineTriggerIds,
    ].filter(Boolean));
    const typeGroupById = new Map<StepId, string | null>();
    const stepTypeById = new Map<StepId, string>();
    for (const st of everyNode) {
        const type = triggerIdSet.has(st.id) ? 'trigger' : (st.type || 'integration_action');
        stepTypeById.set(st.id, type);
        typeGroupById.set(st.id, stepFamily(type));
    }
    const stepNumberById = new Map<StepId, number | string>();
    {
        const order: StepId[] = flowOrder(definition);
        let n = 0;
        const inner = new Map<string, number>(); // prefix -> counter
        const topNumber = new Map<string, number>(); // prefix -> its own number
        for (const id of order) {
            if (stepTypeById.get(id) === 'note') continue;
            if (!isInlineId(id)) {
                n += 1;
                stepNumberById.set(id, n);
                topNumber.set(id, n);
                continue;
            }
            const { prefix } = parseInlineId(id);
            if (inlineTriggerIds.has(id) || stepTypeById.get(id) === 'loop_item') continue;
            const k = (inner.get(prefix) || 0) + 1;
            inner.set(prefix, k);
            const parent = topNumber.get(prefix) ?? stepNumberById.get(prefix);
            stepNumberById.set(id, parent != null ? `${parent}·${k}` : k);
        }
    }
    // A pin needs a captured output. A synthetic 'pinned' row IS the pin.
    const pinnableIds = new Set<StepId>();
    for (const [id, row] of runByStep) {
        if (row && row.output !== undefined && row.status !== 'pinned') pinnableIds.add(id);
    }

    // While the drawer edits a step, its direct source is drawn dashed
    // and what comes next is dimmed (design 1h).
    const editingSourceIds = new Set<StepId>();
    const editingTargetIds = new Set<StepId>();
    if (editingStepId) {
        for (const e of (definition?.edges || [])) {
            if (e?.to === editingStepId && e.from) editingSourceIds.add(e.from);
            if (e?.from === editingStepId && e.to) editingTargetIds.add(e.to);
        }
    }
    return {
        typeGroupById,
        stepTypeById,
        stepNumberById,
        pinnableIds,
        editingStepId,
        editingSourceIds,
        editingTargetIds,
        onPinNode: (editable && !structuralEditsBlocked) ? onPinNode : null,
        pinnedById,
        disabledById,
        customIconById,
        onExecuteStep: editable ? onExecuteStep : null,
        executingStepId,
        runInFlight,
        runIndexById,
        runTotal,
        onOpenLayer: onOpenLayer || null,
        layerSummaries: layerSummaries || {},
        highlightedStepId,
        // Node actions (BFSF-319). Null on a read-only canvas or while the
        // AI holds structural edits, so StepNodeBase renders no chrome.
        onDeleteNode: (editable && !structuralEditsBlocked) ? onDeleteNode : null,
        onDuplicateNode: (editable && !structuralEditsBlocked) ? onDuplicateNode : null,
        onDetachNode: (editable && !structuralEditsBlocked) ? onDetachNode : null,
        // A node writing back its own fields — a note's inline text/size/
        // color edits (BFSF-411). Same editability gate as the actions
        // above; a read-only canvas renders the note but cannot change it.
        onPatchStep: (editable && !structuralEditsBlocked) ? onPatchStep : null,
        // Which nodes are wired to anything — the Disconnect button is
        // pointless on a loose card, so it isn't rendered there. Nor on a
        // step inside a loop: its links are derived from the body's order,
        // so "take it out of the flow" would be undone on the next render.
        // Deleting it, or dragging it somewhere else in the chain, are the
        // two things that mean something there.
        attachedIds: new Set(
            (definition?.edges || [])
                .flatMap(e => [e.from, e.to])
                .filter((id): id is StepId => !!id && !inLoopBody(id)),
        ),
        primaryTriggerId: definition?.trigger?.id || null,
        // A flowlet's `layer_input` node is its trigger, so it gets the
        // same treatment as one: never duplicated, never detached, and —
        // since its mini-definition needs exactly one — never deleted.
        triggerIds: new Set([
            definition?.trigger?.id,
            ...(definition?.triggers || []).map(t => t?.id),
            ...inlineTriggerIds,
        ].filter(Boolean) as StepId[]),
        undeletableIds: inlineTriggerIds,
        // Expand/collapse a flowlet in place. Offered on a read-only canvas
        // too — looking inside a sub-flow isn't an edit.
        onToggleInline,
        inlineExpanded: inlineExpandedIds,
        layerRefCounts,
    };
}

export type RuntimeContext = ReturnType<typeof buildRuntimeContext>;
