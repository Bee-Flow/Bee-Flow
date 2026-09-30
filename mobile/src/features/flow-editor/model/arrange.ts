/**
 * "Arrange" (the button that gives a canvas its shape back) and
 * `seedPositions` (a position for every node that lacks one) — ports of the
 * web builder's flow/arrange.js and flow/layout.js `seedPositions`, pinned by
 * layout.lockstep.test.ts.
 *
 * seedPositions never moves a node that has a position; Arrange overwrites on
 * purpose, and the caller commits it as one undoable edit. Notes and inline
 * (expanded-container) nodes never take part: a note is free-floating.
 */

import { toolLayoutHeights } from './geometry';
import { DEFAULT_DIMS, DEFAULT_SPACING, graphNodes, isFinitePos, isInlineId, runDagre, type Dims, type Spacing } from './layout';
import { DEFAULT_COLUMNS, chunkRanks, measureRows, placeRows, rowLayoutPositions, toRanks } from './rows';
import type { AnyNode, FlowDefinition, FlowEdge, Position } from './types';

export const ARRANGE_MODES = Object.freeze(['compact', 'roomy', 'serpentine'] as const);
export type ArrangeMode = (typeof ARRANGE_MODES)[number];

const SPACING: Readonly<Record<ArrangeMode, Spacing>> = Object.freeze({
    compact: { nodesep: DEFAULT_SPACING.nodesep, ranksep: DEFAULT_SPACING.ranksep },
    roomy: { nodesep: 88, ranksep: 140 },
    serpentine: { nodesep: DEFAULT_SPACING.nodesep, ranksep: DEFAULT_SPACING.ranksep },
});

type Graph = Partial<FlowDefinition>;

const layoutNodes = (graph: Graph) => graphNodes(graph).filter((s) => !isInlineId(s.id) && s.type !== 'note');
const layoutEdges = (graph: Graph) =>
    (graph?.edges || []).filter((e) => e?.from && e?.to && !isInlineId(e.from) && !isInlineId(e.to));

interface Viewport {
    viewportWidth?: number;
    viewportHeight?: number;
}

type Ranks = ReturnType<typeof toRanks>;

interface RowGeometry {
    heightById: Map<string, number>;
    dims: Dims;
    colWidth: number;
}

/** How many columns to wrap at: match the viewport's aspect ratio, not its width. */
function chooseColumns(ranks: Ranks, geo: RowGeometry, vp: Viewport): number {
    const { viewportWidth, viewportHeight } = vp;
    if (!viewportWidth) return DEFAULT_COLUMNS;
    if (!viewportHeight) {
        const usable = Math.max(geo.colWidth, viewportWidth - geo.dims.width);
        return Math.max(2, Math.floor(usable / geo.colWidth));
    }
    const target = viewportWidth / viewportHeight;
    let best = ranks.length;
    let bestErr = Infinity;
    for (let cols = 2; cols <= ranks.length; cols += 1) {
        const { width, height } = measureRows(chunkRanks(ranks, cols), geo.heightById, geo.dims, geo.colWidth);
        const err = Math.abs(width / height - target);
        if (err < bestErr) {
            bestErr = err;
            best = cols;
        }
    }
    return Math.max(2, best);
}

/** Fold a long left-to-right chain into rows that fit the viewport. */
function serpentinePositions(nodes: AnyNode[], edges: FlowEdge[], opts: { dims: Dims; spacing: Spacing; vp: Viewport }) {
    const { dims, spacing, vp } = opts;
    const heightById = toolLayoutHeights(nodes, dims.height);
    const ranks = toRanks(nodes, runDagre(nodes, edges, { dims, heightById, spacing }));
    if (ranks.length === 0) return new Map<string, Position>();
    const geo = { heightById, dims, colWidth: dims.width + spacing.ranksep };
    return placeRows(chunkRanks(ranks, chooseColumns(ranks, geo, vp)), heightById, dims, geo.colWidth);
}

function positionsFor(graph: Graph, mode: ArrangeMode, dims: Dims, vp: Viewport): Map<string, Position> {
    const nodes = layoutNodes(graph);
    if (nodes.length === 0) return new Map();
    const edges = layoutEdges(graph);
    const spacing = SPACING[mode] || SPACING.roomy;
    if (mode === 'serpentine') return serpentinePositions(nodes, edges, { dims, spacing, vp });
    return runDagre(nodes, edges, { dims, heightById: toolLayoutHeights(nodes, dims.height), spacing });
}

/** Write positions onto a graph's trigger(s) and steps; inline nodes keep theirs. */
function applyPositions<T extends Graph>(graph: T, positionById: Map<string, Position>): T {
    const apply = <N extends AnyNode>(s: N): N => {
        if (!s || isInlineId(s.id)) return s;
        const p = positionById.get(s.id);
        return p ? { ...s, position: { x: p.x, y: p.y } } : s;
    };
    const triggers = Array.isArray(graph.triggers) ? graph.triggers : null;
    return {
        ...graph,
        ...(graph.trigger ? { trigger: apply(graph.trigger) } : {}),
        ...(triggers ? { triggers: triggers.map(apply) } : {}),
        ...(Array.isArray(graph.steps) ? { steps: graph.steps.map(apply) } : {}),
    };
}

export interface ArrangeOptions extends Viewport {
    mode?: string;
    dims?: Dims;
    /** Also tidy every flowlet. Default: on for 'roomy' only. */
    includeLayers?: boolean | null;
}

interface Resolved {
    mode: ArrangeMode;
    dims: Dims;
    vp: Viewport;
    withLayers: boolean;
}

function resolveOptions(opts: ArrangeOptions): Resolved {
    const mode = opts.mode ?? 'roomy';
    const useMode: ArrangeMode = (ARRANGE_MODES as readonly string[]).includes(mode) ? (mode as ArrangeMode) : 'roomy';
    const includeLayers = opts.includeLayers ?? null;
    return {
        mode: useMode,
        dims: opts.dims ?? DEFAULT_DIMS,
        vp: { viewportWidth: opts.viewportWidth ?? 0, viewportHeight: opts.viewportHeight ?? 0 },
        withLayers: includeLayers === null ? useMode === 'roomy' : includeLayers,
    };
}

/** Tidy the inside of every flowlet; null when there is nothing to do. */
function arrangeLayers(source: Graph['layers'], r: Resolved): Record<string, FlowDefinition> | null {
    if (!source || typeof source !== 'object') return null;
    const layers: Record<string, FlowDefinition> = {};
    let touched = false;
    for (const [key, layer] of Object.entries(source)) {
        layers[key] = layer?.trigger ? applyPositions(layer, positionsFor(layer, r.mode, r.dims, r.vp)) : layer;
        touched = touched || !!layer?.trigger;
    }
    return touched ? layers : null;
}

/** Re-lay-out a whole definition (overwrites every position). */
export function arrangeDefinition<T extends Graph | null | undefined>(def: T, opts: ArrangeOptions = {}): T {
    if (!def || !def.trigger) return def;
    const r = resolveOptions(opts);
    const next = applyPositions(def, positionsFor(def, r.mode, r.dims, r.vp));
    const layers = r.withLayers ? arrangeLayers(def.layers, r) : null;
    return layers ? { ...next, layers } : next;
}

/**
 * A position for every node that has none, from the same row layout the
 * canvas falls back to; nodes that have one keep it. Returns the definition
 * unchanged when every node is placed (or there is no trigger).
 */
export function seedPositions<T extends Graph | null | undefined>(def: T, dims: Dims = DEFAULT_DIMS): T {
    if (!def || !def.trigger) return def;
    const additional = Array.isArray(def.triggers) ? def.triggers : [];
    const all = [def.trigger, ...additional, ...(def.steps || [])].filter((s) => s && !isInlineId(s.id));
    if (all.every((s) => isFinitePos(s.position))) return def;
    const positionById = rowLayoutPositions(
        all,
        (def.edges || []).filter((e) => !isInlineId(e.from) && !isInlineId(e.to)),
        { dims, heightById: toolLayoutHeights(all, dims.height) },
    );
    const apply = <N extends AnyNode>(s: N): N =>
        isFinitePos(s.position) ? s : { ...s, position: positionById.get(s.id) || { x: 0, y: 0 } };
    return {
        ...def,
        trigger: apply(def.trigger),
        ...(additional.length > 0 ? { triggers: additional.map(apply) } : {}),
        steps: (def.steps || []).map(apply),
    };
}
