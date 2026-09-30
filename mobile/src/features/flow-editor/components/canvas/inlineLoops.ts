/**
 * A loop opened up on the canvas: its body drawn INSIDE it, as the web does —
 * the loop half of the web builder's flow/inlineFlowlets.js
 * (composeInlineGraph, measureContainers, toDisplayPosition,
 * shiftForExpansion, nextExpanded), pinned by canvas.lockstep.test.ts, which
 * runs the web module on the same graphs and compares every number.
 *
 * An open loop becomes a container: a header strip, then its "Each item"
 * entry and its body steps at the body's own coordinates (dagre when a body
 * step has none), chained by model/loopBodyEdges — the order the engine runs
 * them in. A body step's canvas id is its address (`loop_1/b_set`, the
 * outline's and the step editor's spelling). Nodes the container grew into
 * are pushed out of its way for display only; nothing here is saved. Which
 * loops are open is the reader's lens, never the definition (the web keeps
 * it per user in storage).
 *
 * Flowlets (call_layer) do not open on the phone: their contents are a
 * shared graph, edited from the flowlet itself.
 */

import {
    DEFAULT_DIMS, graphNodes, graphPositions, isFinitePos, LOOP_ENTRY_ID, loopBodyEdges,
    type AnyNode, type Dims, type FlowEdge, type FlowStep, type Position,
} from '@/features/flow-editor/model';

export const INLINE_SEP = '/';
/** The server's MAX_LAYER_DEPTH: how deep containers nest. */
export const MAX_INLINE_DEPTH = 8;
/** Container chrome: the padding around the contents, and the header strip. */
export const CONTAINER_PAD = 20;
export const CONTAINER_HEADER = 46;
const MIN_CONTAINER_W = 240;
const MIN_CONTAINER_H = CONTAINER_HEADER + CONTAINER_PAD * 2 + 72;

export interface LoopContainer {
    prefix: string;
    callStepId: string;
    /** The container this one sits in; '' at the top level. */
    parentPrefix: string;
    depth: number;
    /** Normally {0,0}; a body step dragged into negative space moves it. */
    origin: Position;
    childIds: string[];
    /** The "Each item" entry's canvas id. */
    entryId: string;
    size: Dims;
}

export interface ComposedLoops {
    containers: Map<string, LoopContainer>;
    /** Every node inside an open loop (entries included), by canvas id, at its position inside the container. */
    children: Map<string, AnyNode>;
    /** The body chains, in canvas ids; the link into each entry is `__containerEntry`. */
    edges: FlowEdge[];
}

export const makeInlineId = (prefix: string, localId: string): string => (prefix ? `${prefix}${INLINE_SEP}${localId}` : String(localId));

export function parseInlineId(id: string): { prefix: string; localId: string } {
    const s = String(id || '');
    const cut = s.lastIndexOf(INLINE_SEP);
    return cut < 0 ? { prefix: '', localId: s } : { prefix: s.slice(0, cut), localId: s.slice(cut + 1) };
}

const isInlineId = (id: unknown): boolean => typeof id === 'string' && id.includes(INLINE_SEP);

/**
 * "Each item": the synthetic node a body starts from. Never saved; its
 * position is derived (a card's width left of the leftmost body step), so it
 * neither wanders nor forces the body through dagre.
 */
function loopEntryNode(step: FlowStep, body: FlowStep[], dims: Dims): AnyNode {
    const positioned = body.filter((s) => isFinitePos(s?.position));
    let position: Position = { x: 0, y: 0 };
    if (body.length > 0 && positioned.length === body.length) {
        const leftmost = positioned.reduce((a, s) => ((s.position as Position).x < (a.position as Position).x ? s : a));
        const at = leftmost.position as Position;
        position = { x: at.x - (dims.width + 40), y: at.y };
    }
    return {
        id: LOOP_ENTRY_ID,
        type: 'loop_item',
        itemVar: step.itemVar || 'item',
        overRef: step.overRef || '',
        batchSize: Math.max(1, Number(step.batchSize) || 1),
        position,
    } as AnyNode;
}

function loopGraph(step: FlowStep, dims: Dims) {
    const body = (Array.isArray(step.body) ? (step.body as FlowStep[]) : []).filter((s) => s?.id);
    return { trigger: loopEntryNode(step, body, dims), steps: body, edges: loopBodyEdges(body) };
}

interface Pass {
    want: ReadonlySet<string>;
    dims: Dims;
    out: ComposedLoops;
}

function originOf(nodes: AnyNode[], positions: Map<string, Position>): Position {
    let x = 0;
    let y = 0;
    for (const n of nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        x = Math.min(x, p.x);
        y = Math.min(y, p.y);
    }
    return { x, y };
}

function openLoop(step: FlowStep, prefix: string, depth: number, pass: Pass): FlowStep[] | null {
    const flatId = makeInlineId(prefix, step.id);
    const sub = loopGraph(step, pass.dims);
    const nodes = graphNodes(sub);
    // A local id containing the separator would make the canvas id ambiguous: refuse rather than corrupt.
    if (nodes.length === 0 || nodes.some((n) => isInlineId(n.id))) return null;
    const positions = graphPositions(sub, pass.dims);
    const childIds: string[] = [];
    for (const n of nodes) {
        const id = makeInlineId(flatId, n.id);
        childIds.push(id);
        pass.out.children.set(id, { ...n, id, position: positions.get(n.id) || { x: 0, y: 0 } });
    }
    for (const e of sub.edges) pass.out.edges.push({ ...e, from: makeInlineId(flatId, e.from), to: makeInlineId(flatId, e.to) });
    const entryId = makeInlineId(flatId, LOOP_ENTRY_ID);
    pass.out.edges.push({ from: flatId, to: entryId, __containerEntry: true });
    pass.out.containers.set(flatId, {
        prefix: flatId, callStepId: step.id, parentPrefix: prefix, depth, origin: originOf(nodes, positions), childIds, entryId,
        size: { width: MIN_CONTAINER_W, height: MIN_CONTAINER_H },
    });
    return sub.steps;
}

function inline(steps: readonly FlowStep[], prefix: string, depth: number, pass: Pass): void {
    for (const step of steps) {
        if (!step?.id || step.type !== 'loop' || depth >= MAX_INLINE_DEPTH) continue;
        if (!pass.want.has(makeInlineId(prefix, step.id))) continue;
        const body = openLoop(step, prefix, depth, pass);
        if (body) inline(body, makeInlineId(prefix, step.id), depth + 1, pass);
    }
}

/** Where a container's contents start, inside the container's own box. */
function containerOffset(entry: LoopContainer): Position {
    return { x: CONTAINER_PAD - entry.origin.x, y: CONTAINER_HEADER + CONTAINER_PAD - entry.origin.y };
}

/**
 * A node's position on the canvas, relative to its container (the web's
 * React Flow `parentId` convention) — or, at the top level, pushed aside by
 * the open containers.
 */
export function toDisplayPosition(
    id: string,
    pos: Position | null | undefined,
    containers: ReadonlyMap<string, LoopContainer>,
    shiftById: ReadonlyMap<string, { dx: number; dy: number }> | null = null,
): Position {
    const p = pos || { x: 0, y: 0 };
    const { prefix } = parseInlineId(id);
    const parent = prefix ? containers.get(prefix) : null;
    if (parent) {
        const o = containerOffset(parent);
        return { x: p.x + o.x, y: p.y + o.y };
    }
    const shift = shiftById?.get(id);
    return shift ? { x: p.x + shift.dx, y: p.y + shift.dy } : { x: p.x, y: p.y };
}

/** Size every container from its contents, innermost first, so a nested one grows its parents. */
function measure(composed: ComposedLoops, dims: Dims): void {
    const byDepth = [...composed.containers.values()].sort((a, b) => b.depth - a.depth);
    for (const entry of byDepth) {
        let maxRight = 0;
        let maxBottom = 0;
        for (const childId of entry.childIds) {
            const child = composed.containers.get(childId);
            const w = child ? child.size.width : dims.width;
            const h = child ? child.size.height : dims.height;
            const p = toDisplayPosition(childId, composed.children.get(childId)?.position, composed.containers);
            maxRight = Math.max(maxRight, p.x + w);
            maxBottom = Math.max(maxBottom, p.y + h);
        }
        entry.size = {
            width: Math.max(MIN_CONTAINER_W, Math.round(maxRight + CONTAINER_PAD)),
            height: Math.max(MIN_CONTAINER_H, Math.round(maxBottom + CONTAINER_PAD)),
        };
    }
}

/** Open every loop in `expanded` (canvas ids; a nested loop opens only inside an open one). */
export function composeLoops(steps: readonly FlowStep[] | null | undefined, expanded: ReadonlySet<string>, dims: Dims = DEFAULT_DIMS): ComposedLoops {
    const out: ComposedLoops = { containers: new Map(), children: new Map(), edges: [] };
    if (!steps || expanded.size === 0) return out;
    inline(steps, '', 0, { want: expanded, dims, out });
    measure(out, dims);
    return out;
}

/**
 * How far each top-level node moves to make room for the open containers:
 * only nodes the container GREW INTO are pushed, by exactly how much it grew,
 * so closing it puts everything back.
 */
export function shiftForExpansion(
    topLevel: readonly AnyNode[],
    containers: ReadonlyMap<string, LoopContainer>,
    dims: Dims = DEFAULT_DIMS,
): Map<string, { dx: number; dy: number }> {
    const out = new Map<string, { dx: number; dy: number }>();
    for (const entry of containers.values()) {
        if (entry.parentPrefix) continue;
        const box = topLevel.find((s) => s.id === entry.prefix)?.position;
        if (box) pushAside(topLevel, entry, { box, dims, out });
    }
    return out;
}

interface Push {
    box: Position;
    dims: Dims;
    out: Map<string, { dx: number; dy: number }>;
}

/** Is `at` right of the container, in the rows it grew into? Below it, in the columns? */
function bands(at: Position, entry: LoopContainer, { box, dims }: Push): { right: boolean; below: boolean } {
    const grownRight = box.x + Math.max(entry.size.width, dims.width);
    const grownBottom = box.y + Math.max(entry.size.height, dims.height);
    const inRow = at.y < grownBottom && at.y + dims.height > box.y;
    const inCol = at.x < grownRight && at.x + dims.width > box.x;
    return { right: inRow && at.x >= box.x + dims.width, below: inCol && at.y >= box.y + dims.height };
}

/** One container's share of the shift: the nodes in the band it grew into, by how much it grew. */
function pushAside(topLevel: readonly AnyNode[], entry: LoopContainer, push: Push): void {
    const dw = entry.size.width - push.dims.width;
    const dh = entry.size.height - push.dims.height;
    if (dw <= 0 && dh <= 0) return;
    for (const node of topLevel) {
        if (node.id === entry.prefix || !node.position) continue;
        const band = bands(node.position, entry, push);
        const right = dw > 0 && band.right;
        const below = dh > 0 && band.below;
        if (!right && !below) continue;
        const cur = push.out.get(node.id) || { dx: 0, dy: 0 };
        if (right) cur.dx += dw;
        if (below) cur.dy += dh;
        push.out.set(node.id, cur);
    }
}

/** Open or close a loop; closing one closes everything inside it too. */
export function toggleExpanded(prev: ReadonlySet<string>, prefix: string): Set<string> {
    const next = new Set(prev);
    if (!next.has(prefix)) {
        next.add(prefix);
        return next;
    }
    for (const p of [...next]) if (p === prefix || p.startsWith(`${prefix}${INLINE_SEP}`)) next.delete(p);
    return next;
}
