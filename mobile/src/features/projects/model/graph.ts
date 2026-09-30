/**
 * Reading the wiring graph of one Solution (server/projects/graph.js) —
 * ports of dependenciesByNode and formTriggeredRoutines
 * (projects/SolutionContentTable.jsx) and the grouping of the Flow tab
 * (projects/ProjectFlowTab.jsx).
 *
 * The Flow tab is deliberately a grouped LIST and not a node diagram, on the
 * web as here: "what depends on what, and what is broken" reads better as
 * prose at this size, and a phone has even less room for a layout engine.
 */

import type { GraphEdge, GraphNode, SolutionGraph } from './solution';

/** The graph's node id for a member: `<type>:<id>` (graph.js nodeId). */
export function nodeIdFor(kind: string, id: string): string {
    return `${kind}:${id}`;
}

/**
 * Outgoing edges per node, resolved to nodes the graph actually drew. An edge
 * pointing outside the Solution is NOT a dependency pill: it is a finding,
 * and the Check tab is where findings live.
 */
export function dependenciesByNode(graph: SolutionGraph | null | undefined): Map<string, GraphNode[]> {
    const nodes = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const out = new Map<string, GraphNode[]>();
    for (const edge of graph?.edges ?? []) {
        const target = edge.to ? nodes.get(edge.to) : undefined;
        if (!edge.from || !target) continue;
        const list = out.get(edge.from) ?? [];
        if (!list.some((d) => d.id === target.id)) list.push(target);
        out.set(edge.from, list);
    }
    return out;
}

/** Which routine nodes a public form starts — from the graph's form nodes only. */
export function formTriggeredRoutines(graph: SolutionGraph | null | undefined): Set<string> {
    const ids = new Set<string>();
    for (const node of graph?.nodes ?? []) {
        if (node.type === 'form' && node.triggers) ids.add(node.triggers);
    }
    return ids;
}

export interface WiringGroup {
    from: GraphNode | null;
    fromId: string;
    /** Each edge with the node it points at, when the graph drew that node. */
    edges: { edge: GraphEdge; target: GraphNode | null }[];
}

/**
 * The edges grouped by what does the calling, because that is how someone
 * looks for it: "what does this app touch?", not "who touches this routine?".
 * Order is the graph's own, first appearance first.
 */
export function wiringGroups(graph: SolutionGraph): WiringGroup[] {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const groups = new Map<string, WiringGroup>();
    for (const edge of graph.edges) {
        const group = groups.get(edge.from) ?? { from: nodes.get(edge.from) ?? null, fromId: edge.from, edges: [] };
        group.edges.push({ edge, target: edge.to ? (nodes.get(edge.to) ?? null) : null });
        groups.set(edge.from, group);
    }
    return [...groups.values()];
}
