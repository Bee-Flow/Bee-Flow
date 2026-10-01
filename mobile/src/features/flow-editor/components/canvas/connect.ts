/**
 * Drawing and removing a connection by hand — the web canvas's onConnect and
 * its edge "×" (flow/useEdgeEditCallbacks.js), on the same rules, as pure
 * edits for the draft store.
 *
 * A connection is refused, with the reason, when:
 *   - it joins a node to itself, or either end is not a step that takes one
 *     (a trigger has no input, a note no ports at all);
 *   - either end is inside a loop body: a body runs top to bottom, its lines
 *     are drawn from its order, and a hand-drawn one would vanish;
 *   - it leaves a Condition or a Switch without naming a branch (the runtime
 *     routes those on labels only, so an unlabelled line never fires);
 *   - it leaves a step after which nothing runs (Stop with error, Return to
 *     app);
 *   - the same branch already runs to the same step;
 *   - it would close a cycle.
 * Otherwise the edge is added with its branch (branchFromHandle), every node
 * gets a position (seedPositions), and the target's empty inputs are filled
 * from what now flows into it (auto-map), as the web does.
 */

import { applyAutoMapToStep, type Catalog } from '@/features/flow-editor/bindings';
import {
    branchFromHandle, createsCycle, isTerminalStep, matchesEdgeIdentity, seedPositions,
    type AnyNode, type FlowDefinition, type FlowEdge,
} from '@/features/flow-editor/model';
import { findNode, isNestedAddress } from '@/features/flow-editor/model/outline';

export type ConnectRefusal = 'self' | 'no_input' | 'no_output' | 'nested' | 'unlabelled' | 'terminal' | 'duplicate' | 'cycle';

export interface ConnectRequest {
    /** Canvas keys (addresses). */
    source: string;
    target: string;
    /** The source port's wire: then, else, case:<name>, on_error, or null for the plain one. */
    handle: string | null;
}

export type ConnectResult =
    | { ok: true; definition: FlowDefinition; mapped: number }
    | { ok: false; refusal: ConnectRefusal };

const isTrigger = (def: FlowDefinition, id: string) => def.trigger?.id === id || (def.triggers || []).some((t) => t.id === id);

/** Can these two ends take a connection at all? */
function endsRefusal(def: FlowDefinition, source: string, target: string): ConnectRefusal | null {
    if (!source || !target || source === target) return 'self';
    if (isNestedAddress(source) || isNestedAddress(target)) return 'nested';
    const from = findNode(def, source);
    if (!from || from.type === 'note') return 'no_output';
    const to = findNode(def, target);
    if (!to || to.type === 'note' || isTrigger(def, target)) return 'no_input';
    return isTerminalStep(from) ? 'terminal' : null;
}

/** Why `request` cannot be drawn, or null when it can. */
export function connectRefusal(def: FlowDefinition, { source, target, handle }: ConnectRequest): ConnectRefusal | null {
    const ends = endsRefusal(def, source, target);
    if (ends) return ends;
    const from = findNode(def, source) as AnyNode;
    const branch = branchFromHandle(handle);
    if ((from.type === 'condition' || from.type === 'switch') && !branch.label) return 'unlabelled';
    const dup = def.edges.some((e) => e.from === source && e.to === target && (e.label || null) === (branch.label || null));
    if (dup) return 'duplicate';
    return createsCycle(def, source, target) ? 'cycle' : null;
}

/** Draw the connection, or say why not. */
export function connectNodes(def: FlowDefinition, request: ConnectRequest, { catalog = null }: { catalog?: Catalog | null } = {}): ConnectResult {
    const refusal = connectRefusal(def, request);
    if (refusal) return { ok: false, refusal };
    const edge: FlowEdge = { from: request.source, to: request.target, ...branchFromHandle(request.handle) };
    // The layout as drawn is kept (written down first), then the line added:
    // laying out with the new line would move half the flow.
    const placed = seedPositions(def) as FlowDefinition;
    let next: FlowDefinition = { ...placed, edges: [...placed.edges, edge] };
    if (!catalog) return { ok: true, definition: next, mapped: 0 };
    const mapped = applyAutoMapToStep(next, request.target, catalog);
    next = mapped.definition;
    return { ok: true, definition: next, mapped: mapped.mappedKeys.length };
}

export interface EdgeRef {
    from: string;
    to: string;
    /** The source port the line leaves by (the fallback identity). */
    sourceHandle: string | null;
    /** The definition row's own identity. */
    defLabel: string | null;
    defCaseName: string | null;
}

/**
 * Remove exactly one connection — the web's edge "×": matched on the row's
 * own branch identity, so a sibling branch into the same step survives.
 */
export function removeConnection(def: FlowDefinition, ref: EdgeRef): FlowDefinition {
    const identity = ref.defLabel != null || ref.defCaseName != null
        ? { label: ref.defLabel ?? undefined, caseName: ref.defCaseName ?? undefined }
        : branchFromHandle(ref.sourceHandle);
    const hasIdentity = identity.label != null || identity.caseName != null;
    const matches = (e: FlowEdge) => {
        if (e.from !== ref.from || e.to !== ref.to) return false;
        if (!hasIdentity && ref.sourceHandle == null) return true;
        return matchesEdgeIdentity(e, identity);
    };
    const edges = def.edges.filter((e) => !matches(e));
    return edges.length === def.edges.length ? def : { ...(seedPositions(def) as FlowDefinition), edges };
}
