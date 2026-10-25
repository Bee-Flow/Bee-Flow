/**
 * "Let go here and I'll wire it up" — what a node being DRAGGED would connect
 * to if the user released now.
 *
 * Dropping a step from the ribbon already resolves its target by hit-testing
 * the DOM (flow/stepDrag.js). A node being dragged can't: the element under
 * the cursor is the dragged node itself. So this works on geometry — the
 * dragged card's box against the other nodes' boxes and the straight run
 * between each connection's two ends.
 *
 * Only a LOOSE node (no connections of its own) can pick up a target. Dragging
 * a wired node is repositioning, and silently re-plumbing the graph because it
 * passed near something would be the opposite of helpful.
 *
 * Pure; no React, no DOM.
 */

import { isTerminalStep } from './terminalSteps';
import type { FlowDefinition, FlowEdge, FlowStep } from './types';

interface Point { x: number; y: number }
interface RectNode {
    id: string;
    position?: Point;
    width?: number | null;
    height?: number | null;
    measured?: { width?: number; height?: number };
}
interface RenderedEdge {
    id: string;
    source: string;
    target: string;
    data?: { defLabel?: string | null; defCaseName?: string | null };
}
interface NodeRect { x: number; y: number; w: number; h: number; cx: number; cy: number }

/** Where a dragged card lands: onto a connection (`edge`) or beside another card (`node`). */
export type NodeDropTarget =
    | { kind: 'edge'; edgeId: string; sourceId: string; targetId: string; label: string | null; caseName: string | null; nodeId?: undefined; from?: undefined; to?: undefined }
    | { kind: 'node'; nodeId: string; from: string; to: string; edgeId?: undefined; sourceId?: undefined; targetId?: undefined; label?: undefined; caseName?: undefined };

// The canvas lays cards out at 240×96 (flow/layout.js dims); React Flow only
// reports `measured` once a node has actually been rendered.
const DEFAULT_W = 240;
const DEFAULT_H = 96;

/** How close the dragged card must come, in flow units. */
const EDGE_SNAP = 70;   // centre → the line between a connection's ends
const NODE_GAP = 150;   // horizontal gap between two cards
const NODE_OVERLAP = 70; // vertical offset still counted as "in line"

export function nodeRect(node: RectNode | null | undefined): NodeRect {
    const w = node?.measured?.width ?? node?.width ?? DEFAULT_W;
    const h = node?.measured?.height ?? node?.height ?? DEFAULT_H;
    const x = node?.position?.x ?? 0;
    const y = node?.position?.y ?? 0;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** Shortest distance from point p to the segment a→b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Does this step have any connection of its own? */
function isLoose(stepId: string, edges: FlowEdge[] | null | undefined): boolean {
    return !(edges || []).some((e: FlowEdge) => e.from === stepId || e.to === stepId);
}

/** Would `from → to` close a loop? (same walk as DiagramPane's createsCycle) */
function createsCycle(edges: FlowEdge[] | null | undefined, from: string, to: string): boolean {
    const adj = new Map<string | undefined, Array<string | undefined>>();
    for (const e of (edges || [])) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        (adj.get(e.from) as Array<string | undefined>).push(e.to);
    }
    const stack: Array<string | undefined> = [to];
    const seen = new Set<string | undefined>();
    while (stack.length) {
        const cur = stack.pop();
        if (cur === from) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of (adj.get(cur) || [])) stack.push(next);
    }
    return false;
}

/**
 * Resolve the drop target for a node being dragged.
 *
 *   draggedId   — the node being dragged
 *   nodes       — rendered React Flow nodes (position + measured size)
 *   renderedEdges — rendered edges ({id, source, target, data:{defLabel,defCaseName}})
 *   definition  — the graph (steps + edges), for identity and the loose check
 */
export function findNodeDropTarget({ draggedId, nodes = [], renderedEdges = [], definition = null }: {
    draggedId?: string | null;
    nodes?: RectNode[];
    renderedEdges?: RenderedEdge[];
    definition?: FlowDefinition | null;
}): NodeDropTarget | null {
    if (!draggedId || !definition) return null;
    const edges = definition.edges || [];
    if (!isLoose(draggedId, edges)) return null;

    const byId = new Map(nodes.map((n: RectNode) => [n.id, n]));
    const dragged = byId.get(draggedId);
    if (!dragged) return null;
    const me = nodeRect(dragged);

    const stepById = new Map<string, FlowStep>();
    if (definition.trigger?.id) stepById.set(definition.trigger.id, definition.trigger);
    for (const t of (definition.triggers || [])) if (t?.id) stepById.set(t.id, t);
    for (const s of (definition.steps || [])) if (s?.id) stepById.set(s.id, s);
    const draggedStep = stepById.get(draggedId);
    const draggedIsTrigger = !!draggedStep && draggedStep.type === 'trigger';
    // A note (BFSF-411) never connects to anything — dragging one near a
    // connection or another card must not offer to splice/chain it in, the
    // same way a trigger (which also can't be a wiring target here) is
    // excluded above.
    if (draggedStep?.type === 'note') return null;

    // ── A connection: splice the node into it ────────────────────────────
    // Measured from the ports the edge actually leaves and enters, so a card
    // hovering over the middle of a long connection wins over one that merely
    // sits near both endpoints.
    let best: { d: number; target: NodeDropTarget } | null = null;
    if (!draggedIsTrigger) {
        for (const e of renderedEdges) {
            if (e.source === draggedId || e.target === draggedId) continue;
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (!a || !b) continue;
            const ra = nodeRect(a);
            const rb = nodeRect(b);
            const d = distanceToSegment(
                { x: me.cx, y: me.cy },
                { x: ra.x + ra.w, y: ra.cy },
                { x: rb.x, y: rb.cy },
            );
            if (d > EDGE_SNAP) continue;
            if (!best || d < best.d) {
                best = {
                    d,
                    target: {
                        kind: 'edge',
                        edgeId: e.id,
                        sourceId: e.source,
                        targetId: e.target,
                        label: e.data?.defLabel ?? null,
                        caseName: e.data?.defCaseName ?? null,
                    },
                };
            }
        }
    }
    if (best) return best.target;

    // ── A node: chain onto it ────────────────────────────────────────────
    // Direction follows the layout: a card dropped to the RIGHT of another
    // continues from it; to the LEFT it feeds into it. Triggers can only ever
    // be the source.
    let bestNode: { gap: number; target: NodeDropTarget } | null = null;
    for (const other of nodes) {
        if (other.id === draggedId) continue;
        const r = nodeRect(other);
        if (Math.abs(r.cy - me.cy) > NODE_OVERLAP) continue;
        const otherStep = stepById.get(other.id);
        // Never chain onto/from a note — it isn't a flow node to wire against.
        if (otherStep?.type === 'note') continue;
        const otherIsTrigger = !!otherStep && otherStep.type === 'trigger';

        const gapRight = me.x - (r.x + r.w);   // dragged sits right of `other`
        const gapLeft = r.x - (me.x + me.w);   // dragged sits left of `other`
        let from: string | null = null, to: string | null = null, gap: number | null = null;
        if (gapRight >= 0 && gapRight <= NODE_GAP) { from = other.id; to = draggedId; gap = gapRight; }
        else if (gapLeft >= 0 && gapLeft <= NODE_GAP) { from = draggedId; to = other.id; gap = gapLeft; }
        if (!from) continue;

        // Nothing runs after a TERMINAL step, and nothing runs INTO a trigger.
        if (isTerminalStep(stepById.get(from))) continue;
        if (to === draggedId ? draggedIsTrigger : otherIsTrigger) continue;
        if (edges.some((e: FlowEdge) => e.from === from && e.to === to)) continue;
        if (createsCycle(edges, from, to as string)) continue;

        if (!bestNode || (gap as number) < bestNode.gap) bestNode = { gap: gap as number, target: { kind: 'node', nodeId: other.id, from, to: to as string } };
    }
    return bestNode ? bestNode.target : null;
}

/** Do two resolved targets point at the same thing? (re-render guard) */
export function sameNodeDropTarget(a: NodeDropTarget | null | undefined, b: NodeDropTarget | null | undefined): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    return a.kind === 'edge' ? a.edgeId === b.edgeId : (a.nodeId === b.nodeId && a.from === b.from);
}
