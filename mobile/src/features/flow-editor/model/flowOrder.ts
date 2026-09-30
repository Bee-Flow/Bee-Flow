/**
 * The steps of a graph in the order they RUN — a port of the web builder's
 * flow/flowOrder.js (BFSF-332), pinned by flowOrder.lockstep.test.ts.
 *
 * `definition.steps[]` is authoring order, rarely run order. The node editor
 * pages through this sequence ("step 3 of 7") and the outline lists it.
 *
 * Kahn over `edges`, seeded from the trigger(s):
 *   - deterministic: ties break on edge order, then `steps[]` index;
 *   - total: whatever a cycle leaves unreachable is appended in authoring
 *     order, so every node can be paged to;
 *   - shallow: loop bodies and parallel branches are not descended into.
 */

import type { AnyNode, DefinitionInput } from './types';

function nodesOf(definition: DefinitionInput): AnyNode[] {
    const steps = Array.isArray(definition?.steps) ? definition.steps.filter(Boolean) : [];
    const triggers = Array.isArray(definition?.triggers) ? definition.triggers : [];
    const roots = [definition?.trigger, ...triggers].filter((t): t is NonNullable<typeof t> => !!t && !!t.id);
    return [...roots, ...steps];
}

interface Graph {
    index: Map<string, number>;
    outgoing: Map<string, { to: string; order: number }[]>;
    indegree: Map<string, number>;
}

function buildGraph(definition: DefinitionInput, nodes: AnyNode[]): Graph {
    const index = new Map<string, number>();
    nodes.forEach((n, i) => {
        if (n?.id != null && !index.has(n.id)) index.set(n.id, i);
    });
    const edges = (Array.isArray(definition?.edges) ? definition.edges : []).filter(
        (e) => e && index.has(e.from) && index.has(e.to),
    );
    const outgoing = new Map<string, { to: string; order: number }[]>();
    const indegree = new Map<string, number>([...index.keys()].map((id) => [id, 0]));
    edges.forEach((e, order) => {
        const list = outgoing.get(e.from) ?? [];
        list.push({ to: e.to, order });
        outgoing.set(e.from, list);
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
    });
    return { index, outgoing, indegree };
}

/** Every node id (triggers first), in run order. */
export function flowOrder(definition: DefinitionInput): string[] {
    const { index, outgoing, indegree } = buildGraph(definition, nodesOf(definition));
    if (index.size === 0) return [];

    const byIndex = (a: string, b: string) => (index.get(a) as number) - (index.get(b) as number);
    const ready = [...index.keys()].filter((id) => (indegree.get(id) || 0) === 0).sort(byIndex);

    const out: string[] = [];
    const seen = new Set<string>();
    while (ready.length) {
        const id = ready.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        const next = (outgoing.get(id) || []).slice().sort((a, b) => a.order - b.order);
        for (const { to } of next) {
            const left = (indegree.get(to) || 0) - 1;
            indegree.set(to, left);
            if (left <= 0 && !seen.has(to)) {
                ready.push(to);
                ready.sort(byIndex);
            }
        }
    }
    for (const id of index.keys()) if (!seen.has(id)) out.push(id);
    return out;
}

export interface FlowPosition {
    /** 1-based, for display; 0 when the step is not in the graph. */
    index: number;
    total: number;
    prevId: string | null;
    nextId: string | null;
}

/** Where one step sits in the run order, for the node editor's paging. */
export function flowPosition(definition: DefinitionInput, stepId: string): FlowPosition {
    const order = flowOrder(definition);
    const i = order.indexOf(stepId);
    if (i < 0) return { index: 0, total: order.length, prevId: null, nextId: null };
    return {
        index: i + 1,
        total: order.length,
        prevId: i > 0 ? (order[i - 1] as string) : null,
        nextId: i < order.length - 1 ? (order[i + 1] as string) : null,
    };
}

export interface InlineIdHelpers {
    isInlineId?: ((id: string) => boolean) | null;
    parseInlineId?: ((id: string) => { prefix: string; localId: string }) | null;
}

function typesById(definition: DefinitionInput): Map<string, string | undefined> {
    const typeOf = new Map<string, string | undefined>();
    const triggers = Array.isArray(definition?.triggers) ? definition.triggers : [];
    for (const tr of [definition?.trigger, ...triggers]) if (tr?.id) typeOf.set(tr.id, 'trigger');
    for (const st of Array.isArray(definition?.steps) ? definition.steps : []) if (st?.id) typeOf.set(st.id, st.type);
    return typeOf;
}

/**
 * The number each step wears ("AI STEP · 7"): 1, 2, 3… in run order, notes
 * skipped. Inline (expanded) children count inside their parent — `3·1` —
 * when the caller hands over the inline-id helpers.
 */
export function stepNumbers(
    definition: DefinitionInput,
    { isInlineId = null, parseInlineId = null }: InlineIdHelpers = {},
): Map<string, number | string> {
    const typeOf = typesById(definition);
    const out = new Map<string, number | string>();
    const inner = new Map<string, number>();
    let n = 0;
    for (const id of flowOrder(definition)) {
        const type = typeOf.get(id);
        if (type === 'note') continue;
        if (!isInlineId || !parseInlineId || !isInlineId(id)) {
            n += 1;
            out.set(id, n);
            continue;
        }
        if (type === 'trigger' || type === 'loop_item') continue;
        const { prefix } = parseInlineId(id);
        const k = (inner.get(prefix) || 0) + 1;
        inner.set(prefix, k);
        const parent = out.get(prefix);
        out.set(id, parent != null ? `${parent}·${k}` : k);
    }
    return out;
}
