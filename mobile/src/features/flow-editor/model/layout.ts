/**
 * Dagre auto-layout for an automation graph, with a small LRU — a port of the
 * web builder's flow/dagreLayout.js, on the same @dagrejs/dagre major, pinned
 * by layout.lockstep.test.ts (which lays the same graphs out with the web
 * module and compares every coordinate).
 *
 * A saved definition normally has a position on every node already; this is
 * for the ones that do not, and for "Auto-arrange". Rank direction is left to
 * right, as on the web, so the phone's canvas and the browser's agree.
 */

import { graphlib, layout } from '@dagrejs/dagre';

import type { AnyNode, FlowEdge, Position } from './types';

const LAYOUT_CACHE_CAP = 8;
const layoutCache = new Map<string, Map<string, Position>>();

export interface Dims {
    width: number;
    height: number;
}

export interface Spacing {
    nodesep: number;
    ranksep: number;
}

/** The default gaps — a FLOOR for readable edge chips, measured on the web. */
export const DEFAULT_SPACING: Readonly<Spacing> = Object.freeze({ nodesep: 64, ranksep: 80 });

/** Card size the layout reserves (the web's 240×96 layout box). */
export const DEFAULT_DIMS: Readonly<Dims> = Object.freeze({ width: 240, height: 96 });

/** Inline (expanded-container) ids carry a `/`; they belong to another graph. */
export const INLINE_SEP = '/';
export const isInlineId = (id: unknown): boolean => typeof id === 'string' && id.includes(INLINE_SEP);

export function isFinitePos(p: unknown): p is Position {
    if (!p || typeof p !== 'object') return false;
    const { x, y } = p as { x?: unknown; y?: unknown };
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
}

type LayoutNode = Pick<AnyNode, 'id'>;
type LayoutEdge = Pick<FlowEdge, 'from' | 'to' | 'label' | 'caseName'>;

interface Shape {
    dims: Dims;
    heights: Map<string, number> | null;
    gaps: Spacing;
}

function cacheKey(nodes: LayoutNode[], edges: LayoutEdge[], { dims, heights, gaps }: Shape) {
    const nodeIds = nodes.map((s) => s.id).sort().join(',');
    const edgeKey = edges
        .filter((e) => e.from && e.to)
        .map((e) => `${e.from}>${e.to}|${e.label || ''}|${e.caseName ?? ''}`)
        .sort()
        .join('|');
    const hs = heights && heights.size ? [...heights.entries()].map(([id, h]) => `${id}:${h}`).sort().join(',') : '';
    return `${dims.width}x${dims.height}@${gaps.nodesep}/${gaps.ranksep}#${nodeIds}#${edgeKey}#${hs}`;
}

function remember(key: string, positions: Map<string, Position>) {
    if (layoutCache.has(key)) layoutCache.delete(key);
    layoutCache.set(key, positions);
    if (layoutCache.size > LAYOUT_CACHE_CAP) {
        const oldest = layoutCache.keys().next().value;
        if (oldest !== undefined) layoutCache.delete(oldest);
    }
}

export interface DagreOptions {
    dims?: Dims;
    /** Per-node heights for boxes taller than `dims.height`. */
    heightById?: Map<string, number> | null;
    spacing?: Partial<Spacing>;
}

/**
 * Lay every node out with dagre: Map<id, top-left position>. Memoised on the
 * graph's shape (ids, edge identities, dims, heights, gaps).
 */
export function runDagre(nodes: LayoutNode[], edges: LayoutEdge[], opts: DagreOptions = {}): Map<string, Position> {
    const dims = opts.dims ?? DEFAULT_DIMS;
    const heightById = opts.heightById ?? null;
    const gaps: Spacing = opts.spacing ? { ...DEFAULT_SPACING, ...opts.spacing } : DEFAULT_SPACING;
    const key = cacheKey(nodes, edges, { dims, heights: heightById, gaps });
    const cached = layoutCache.get(key);
    if (cached) {
        layoutCache.delete(key);
        layoutCache.set(key, cached);
        return cached;
    }

    const g = new graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: gaps.nodesep, ranksep: gaps.ranksep, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    const heightOf = (id: string) => heightById?.get(id) ?? dims.height;
    for (const s of nodes) g.setNode(s.id, { width: dims.width, height: heightOf(s.id) });
    for (const e of edges) {
        if (e.from && e.to) g.setEdge(e.from, e.to);
    }
    layout(g);
    const out = new Map<string, Position>();
    for (const s of nodes) {
        const n = (g.node(s.id) as { x?: number; y?: number } | undefined) || { x: 0, y: 0 };
        out.set(s.id, { x: (n.x ?? 0) - dims.width / 2, y: (n.y ?? 0) - heightOf(s.id) / 2 });
    }
    remember(key, out);
    return out;
}

interface GraphLike {
    trigger?: AnyNode | null;
    triggers?: AnyNode[];
    steps?: AnyNode[];
    edges?: FlowEdge[];
}

/** Trigger + secondary triggers + steps, in the order the canvas renders them. */
export function graphNodes(graph: GraphLike | null | undefined): AnyNode[] {
    if (!graph) return [];
    return [
        graph.trigger,
        ...(Array.isArray(graph.triggers) ? graph.triggers : []),
        ...(Array.isArray(graph.steps) ? graph.steps : []),
    ].filter((s): s is AnyNode => !!s && !!s.id);
}

/**
 * Positions for a whole graph, by the canvas's rule: saved coordinates
 * verbatim when EVERY node has one, dagre for the whole graph otherwise (a
 * half-laid-out canvas is worse than a re-laid-out one).
 */
export function graphPositions(graph: GraphLike | null | undefined, dims: Dims = DEFAULT_DIMS): Map<string, Position> {
    const nodes = graphNodes(graph);
    if (nodes.length === 0) return new Map();
    if (nodes.every((s) => isFinitePos(s.position))) {
        return new Map(nodes.map((s) => [s.id, { x: (s.position as Position).x, y: (s.position as Position).y }]));
    }
    return runDagre(nodes, (graph?.edges || []).filter((e) => e?.from && e?.to), { dims });
}
