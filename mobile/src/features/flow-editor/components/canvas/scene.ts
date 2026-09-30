/**
 * Everything the canvas draws, worked out once per edit: every node with its
 * box, ports and kind; every line with its geometry; the "+" spots. Pure — the
 * components only place what this hands them.
 *
 * Positions follow the web's layout rule (flow/layout.js buildLayout): a
 * definition whose steps are all placed is drawn exactly where they were
 * put; one with any unplaced step is laid out whole, in the rows
 * `seedPositions` would give it (dagre ranks, left to right, wrapped into
 * rows of five), and the canvas writes those positions back on its first
 * edit. Notes keep their own place. Open loops are drawn inside their
 * container (inlineLoops.ts), their neighbours pushed out of the way.
 *
 * A node's key is its address: its id, or for a step in a loop body the path
 * down to it (`loop_1/b_set`) — what the step editor and the card menu take.
 */

import {
    CARD_W, DEFAULT_DIMS, isFinitePos, rowLayoutPositions, toolLayoutHeights,
    type AnyNode, type FlowDefinition, type FlowStep, type Position,
} from '@/features/flow-editor/model';

import { composeLoops, parseInlineId, shiftForExpansion, toDisplayPosition, type ComposedLoops, type LoopContainer } from './inlineLoops';
import { cardHeightFor, sourcePorts, targetDy, type PortSpec } from './ports';
import { sceneEdges, type AddSpot, type SceneEdge } from './sceneEdges';
import { unionRect, type Rect } from './viewport';

export type SceneKind = 'trigger' | 'step' | 'note' | 'entry' | 'container';

export interface SceneNode {
    key: string;
    /** The definition id (the local id inside a loop body). */
    nodeId: string;
    kind: SceneKind;
    node: AnyNode;
    x: number;
    y: number;
    width: number;
    height: number;
    /** The open loop that holds it. */
    parent: string | null;
    ports: PortSpec[];
    targetDy: number | null;
    /** Only top-level nodes move: a body's order is its wiring. */
    draggable: boolean;
    /** A loop's step count (its "3 steps inside" chip). */
    bodyCount: number;
    /** Changes whenever anything about the box does: what a memoised node compares. */
    geom: string;
}

export interface Scene {
    nodes: SceneNode[];
    byKey: Map<string, SceneNode>;
    edges: SceneEdge[];
    adds: AddSpot[];
    /** Around every node; null for an empty canvas. */
    bounds: Rect | null;
    /** The positions came from the fallback layout, not the definition. */
    seeded: boolean;
}

/** A note's box before anyone resizes it (layout.js DEFAULT_NOTE_SIZE). */
export const NOTE_SIZE = Object.freeze({ width: 220, height: 140 });
/** The "Each item" pill, right-aligned in the slot a card would take. */
export const ENTRY_W = 180;
export const ENTRY_H = 48;

interface Placed {
    node: AnyNode;
    key: string;
    kind: SceneKind;
    at: Position;
    parent: string | null;
}

/** The top-level positions, by the web's rule; `seeded` when the fallback layout drew them. */
export function topPositions(def: FlowDefinition): { positions: Map<string, Position>; seeded: boolean } {
    const all = [def.trigger, ...(def.triggers || []), ...def.steps].filter((s): s is AnyNode => !!s?.id);
    const ranked = all.filter((s) => s.type !== 'note');
    let positions: Map<string, Position>;
    const seeded = !ranked.every((s) => isFinitePos(s.position));
    if (!seeded) {
        positions = new Map(ranked.map((s) => [s.id, { x: (s.position as Position).x, y: (s.position as Position).y }]));
    } else {
        const heightById = toolLayoutHeights(ranked, DEFAULT_DIMS.height);
        positions = new Map(rowLayoutPositions(ranked, def.edges, { dims: DEFAULT_DIMS, heightById }));
    }
    for (const s of all) if (s.type === 'note') positions.set(s.id, isFinitePos(s.position) ? s.position : { x: 0, y: 0 });
    return { positions, seeded };
}

function sizeOf(p: Placed, containers: ReadonlyMap<string, LoopContainer>): { width: number; height: number } {
    if (p.kind === 'container') return (containers.get(p.key) as LoopContainer).size;
    if (p.kind === 'entry') return { width: ENTRY_W, height: ENTRY_H };
    if (p.kind === 'note') {
        const size = (p.node.size ?? {}) as { width?: unknown; height?: unknown };
        return { width: Math.max(40, Number(size.width) || NOTE_SIZE.width), height: Math.max(40, Number(size.height) || NOTE_SIZE.height) };
    }
    return { width: CARD_W, height: cardHeightFor(p.node) };
}

function toSceneNode(p: Placed, containers: ReadonlyMap<string, LoopContainer>): SceneNode {
    const { width, height } = sizeOf(p, containers);
    const x = p.kind === 'entry' ? p.at.x + CARD_W - ENTRY_W : p.at.x;
    const y = p.kind === 'entry' ? p.at.y + 12 : p.at.y;
    const ports = p.kind === 'entry' ? [{ id: 'out', wire: null, text: null, tone: null, dy: ENTRY_H / 2 }] : sourcePorts(p.node, height, p.kind === 'container');
    const body = p.node.type === 'loop' && Array.isArray(p.node.body) ? p.node.body.length : 0;
    return {
        key: p.key, nodeId: p.kind === 'entry' ? p.node.id : parseInlineId(p.key).localId, kind: p.kind, node: p.node,
        x, y, width, height, parent: p.parent, ports, targetDy: targetDy(p.kind, height),
        draggable: p.parent === null, bodyCount: body,
        geom: `${x}|${y}|${width}|${height}|${ports.map((q) => `${q.id}@${q.dy}`).join(',')}|${body}`,
    };
}

function topLevel(def: FlowDefinition, composed: ComposedLoops, positions: Map<string, Position>): Placed[] {
    const nodes = [def.trigger, ...(def.triggers || []), ...def.steps].filter((s): s is AnyNode => !!s?.id);
    const triggerIds = new Set([def.trigger?.id, ...(def.triggers || []).map((t) => t.id)]);
    const placedNodes = nodes.map((n) => ({ ...n, position: positions.get(n.id) }));
    const shift = shiftForExpansion(placedNodes, composed.containers);
    return nodes.map((node) => {
        const kind: SceneKind = triggerIds.has(node.id) ? 'trigger' : node.type === 'note' ? 'note' : composed.containers.has(node.id) ? 'container' : 'step';
        return { node, key: node.id, kind, at: toDisplayPosition(node.id, positions.get(node.id), composed.containers, shift), parent: null };
    });
}

function children(composed: ComposedLoops, absOf: Map<string, Position>): Placed[] {
    const out: Placed[] = [];
    const byDepth = [...composed.containers.values()].sort((a, b) => a.depth - b.depth);
    for (const c of byDepth) {
        const base = absOf.get(c.prefix);
        if (!base) continue;
        for (const id of c.childIds) {
            const child = composed.children.get(id) as AnyNode;
            const local = toDisplayPosition(id, child.position, composed.containers);
            const at = { x: base.x + local.x, y: base.y + local.y };
            const kind: SceneKind = id === c.entryId ? 'entry' : composed.containers.has(id) ? 'container' : 'step';
            absOf.set(id, at);
            out.push({ node: child, key: id, kind, at, parent: c.prefix });
        }
    }
    return out;
}

/** The canvas for `def`, with the loops in `expanded` (addresses) open. */
export function buildScene(def: FlowDefinition, expanded: ReadonlySet<string> = new Set()): Scene {
    const composed = composeLoops(def.steps as FlowStep[], expanded);
    const { positions, seeded } = topPositions(def);
    const top = topLevel(def, composed, positions);
    const absOf = new Map(top.map((p) => [p.key, p.at]));
    const placed = [...top, ...children(composed, absOf)];
    const byKey = new Map<string, SceneNode>();
    const nodes: SceneNode[] = [];
    for (const p of placed) {
        if (byKey.has(p.key)) continue;
        const n = toSceneNode(p, composed.containers);
        byKey.set(n.key, n);
        nodes.push(n);
    }
    const { edges, adds } = sceneEdges({ nodes, byKey, defEdges: def.edges, composed });
    return { nodes, byKey, edges, adds, bounds: unionRect(nodes), seeded };
}
