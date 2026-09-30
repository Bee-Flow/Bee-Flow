/**
 * Graph surgery for the node actions: delete (healing the graph), detach,
 * duplicate and patch. A port of the web builder's flow/nodeOps.js (BFSF-319),
 * pinned by nodeOps.lockstep.test.ts. Everything is pure.
 */

import { copyExtraEdgeKeys, edgeKey } from './branchEdges';
import { collectIds, uniqueStepId } from './ids';
import { asDefinition } from './normalize';
import type { DefinitionInput, FlowDefinition, FlowEdge, FlowStep } from './types';

const COPY_SUFFIX = ' (copy)';

/** How far below its old spot a disconnected step is parked. */
const DETACH_OFFSET_Y = 160;

/** The branch identity and extra keys of `donor`, onto a fresh `from → to`. */
function inheritEdge(donor: FlowEdge, from: string, to: string): FlowEdge {
    const edge: FlowEdge = { from, to };
    if (donor.label) edge.label = donor.label;
    if (donor.caseName != null) edge.caseName = donor.caseName;
    return copyExtraEdgeKeys(donor, edge);
}

/**
 * Rewire the edges around a step being removed, so its predecessors connect
 * straight to its successors. The branch label comes from the INCOMING edge
 * (an If's `then` that fed the step stays `then`); self-loops and duplicates
 * are dropped.
 */
export function bridgeEdges(edges: FlowEdge[] | null | undefined, removedId: string): FlowEdge[] {
    const list = Array.isArray(edges) ? edges : [];
    const incoming = list.filter((e) => e.to === removedId && e.from !== removedId);
    const outgoing = list.filter((e) => e.from === removedId && e.to !== removedId);
    const kept = list.filter((e) => e.from !== removedId && e.to !== removedId);

    const seen = new Set(kept.map((e) => edgeKey(e)));
    const bridged: FlowEdge[] = [];
    for (const inEdge of incoming) {
        for (const outEdge of outgoing) {
            if (inEdge.from === outEdge.to) continue;
            const edge = inheritEdge(inEdge, inEdge.from, outEdge.to);
            const key = edgeKey(edge);
            if (seen.has(key)) continue;
            seen.add(key);
            bridged.push(edge);
        }
    }
    return [...kept, ...bridged];
}

/**
 * Remove one or more steps, healing the graph around each. The primary
 * trigger is never removable (the runtime needs exactly one); secondary
 * triggers behave like any other node.
 */
export function applyDeleteNodes<T extends DefinitionInput>(definition: T, ids: string | string[]): T | FlowDefinition {
    const base = asDefinition(definition);
    const remove = new Set(Array.isArray(ids) ? ids : [ids]);
    if (base.trigger?.id) remove.delete(base.trigger.id);
    if (remove.size === 0) return definition;

    let edges = base.edges;
    for (const id of remove) edges = bridgeEdges(edges, id);

    const next: FlowDefinition = {
        ...base,
        steps: base.steps.filter((s) => !remove.has(s.id)),
        edges: edges.filter((e) => !remove.has(e.from) && !remove.has(e.to)),
    };
    if (Array.isArray(base.triggers)) next.triggers = base.triggers.filter((t) => !remove.has(t.id));
    return next;
}

/**
 * Take a step OUT of the flow without deleting it: the neighbours are
 * bridged and the step is parked just below where it was, loose. A trigger,
 * or a step that is already loose, comes back unchanged.
 */
export function applyDetachNode<T extends DefinitionInput>(definition: T, stepId: string): T | FlowDefinition {
    const base = asDefinition(definition);
    const step = base.steps.find((s) => s.id === stepId);
    if (!step) return definition;
    if (!base.edges.some((e) => e.from === stepId || e.to === stepId)) return definition;

    const parked: FlowStep = {
        ...step,
        position: { x: step.position?.x ?? 0, y: (step.position?.y ?? 0) + DETACH_OFFSET_Y },
    };
    return {
        ...base,
        steps: base.steps.map((s) => (s.id === stepId ? parked : s)),
        edges: bridgeEdges(base.edges, stepId),
    };
}

function deepClone<T>(v: T): T {
    try {
        return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
    } catch {
        return JSON.parse(JSON.stringify(v));
    }
}

/**
 * Duplicate one step, keeping its configuration. The copy sits below-right
 * of the original, wired from the SAME predecessors (a sibling, not spliced
 * into the chain); outgoing edges are not copied. Its pinned output stays
 * behind: that belongs to the original's run history. Triggers are not
 * duplicable.
 */
export function applyDuplicateNode<T extends DefinitionInput>(
    definition: T,
    stepId: string,
): { definition: T | FlowDefinition; newStepId: string | null } {
    const base = asDefinition(definition);
    const source = base.steps.find((s) => s.id === stepId);
    if (!source) return { definition, newStepId: null };

    const newId = uniqueStepId(source.type, collectIds(base));
    const clone = deepClone(source);
    clone.id = newId;
    clone.label = `${source.label || source.type || 'Step'}${COPY_SUFFIX}`;
    clone.position = { x: (source.position?.x ?? 0) + 40, y: (source.position?.y ?? 0) + 120 };
    delete clone.pinnedOutput;
    delete clone.pinnedAt;
    delete clone.pinnedSource;

    const inherited = base.edges
        .filter((e) => e.to === stepId && e.from !== stepId)
        .map((e) => inheritEdge(e, e.from, newId));

    return {
        definition: { ...base, steps: [...base.steps, clone], edges: [...base.edges, ...inherited] },
        newStepId: newId,
    };
}

/**
 * Shallow-merge a patch onto one step's own fields. Never touches wiring.
 * An unusable id or patch returns the definition unchanged.
 */
export function applyPatchStep<T extends DefinitionInput>(
    definition: T,
    stepId: string,
    patch: Record<string, unknown> | null | undefined,
): T | FlowDefinition {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return definition;
    const base = asDefinition(definition);
    const idx = base.steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return definition;
    const steps = base.steps.slice();
    steps[idx] = { ...(steps[idx] as FlowStep), ...patch };
    return { ...base, steps };
}

/** Can this node be removed? False only for the primary trigger. */
export function canDeleteNode(definition: DefinitionInput, stepId: string | null | undefined): boolean {
    if (!definition || !stepId) return false;
    return definition.trigger?.id !== stepId;
}

/** Can this node be duplicated? Steps only — never a trigger. */
export function canDuplicateNode(definition: DefinitionInput, stepId: string | null | undefined): boolean {
    if (!definition || !stepId) return false;
    return (definition.steps || []).some((s) => s.id === stepId);
}

/** Can this node be disconnected? A step that is actually wired to something. */
export function canDetachNode(definition: DefinitionInput, stepId: string | null | undefined): boolean {
    if (!definition || !stepId) return false;
    if (!(definition.steps || []).some((s) => s.id === stepId)) return false;
    return (definition.edges || []).some((e) => e.from === stepId || e.to === stepId);
}
