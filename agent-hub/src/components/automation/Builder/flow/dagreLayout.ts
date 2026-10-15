import dagre from '@dagrejs/dagre';

/**
 * Dagre auto-layout for an automation graph, with a module-level LRU.
 *
 * Extracted from layout.js so BOTH the canvas layout and the inline-flowlet
 * composer (inlineFlowlets.js) can lay out a graph without importing each
 * other — layout.js imports inlineFlowlets.js, so the shared helper has to
 * live below both of them.
 *
 * The cost of laying out a 30-step graph isn't huge but it adds up: every
 * keystroke in an inspector field rebuilds the draft → `seedPositions` runs →
 * dagre fires. Topology rarely changes between keystrokes, so caching against
 * a structural key (node IDs + edge endpoints + dims) is almost always a hit
 * during text editing. Capacity is intentionally small — we only need to
 * remember a handful of recent shapes.
 */

const LAYOUT_CACHE_CAP = 8;
export interface Point {
    x: number;
    y: number;
}

export interface Dims {
    width: number;
    height: number;
}

export interface Spacing {
    nodesep: number;
    ranksep: number;
}

export interface GraphStep {
    id: string;
    position?: Point;
    [key: string]: unknown;
}

export interface GraphEdge {
    from?: string;
    to?: string;
    label?: string | null;
    caseName?: string | null;
    [key: string]: unknown;
}

export interface GraphLike {
    trigger?: GraphStep | null;
    triggers?: (GraphStep | null | undefined)[];
    steps?: (GraphStep | null | undefined)[];
    edges?: GraphEdge[];
}

const layoutCache = new Map<string, Map<string, Point>>(); // key -> positionById Map

export function isFinitePos(p: Point | null | undefined) {
    return p && typeof p.x === 'number' && typeof p.y === 'number'
        && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * The default gaps, and the only ones the automatic (missing-position) layout
 * ever uses. The Arrange menu passes its own — see arrange.js — which is why
 * they have to travel into the cache key below.
 *
 * Builder redesign (Sep 2026): ranksep 120 → 80, nodesep 48 → 64. The 120 was
 * measured against edge chips that sat BESIDE the line; the redesign puts the
 * chip on the line, 22px tall and clipped to the gap, and draws a 4px type
 * bar on the card, so cards can sit closer without the labels smearing. The
 * design asks for 60; 80 is where "1 record" still fits without truncation
 * at 100% — treat this as a floor, not a suggestion, and revisit only with
 * the chips measured again.
 */
export const DEFAULT_SPACING = Object.freeze({ nodesep: 64, ranksep: 80 });

function layoutCacheKey(allSteps: GraphStep[], edges: GraphEdge[], dims: Dims, heightById: Map<string, number> | null, spacing: Spacing): string {
    // Stable: sort to ignore array order changes that don't affect shape.
    // Includes label/caseName — an edge's REAL identity — so parallel branch
    // edges between the same pair don't collapse into one cache entry.
    const nodeIds = allSteps.map(s => s.id).sort().join(',');
    const edgeKey = edges
        .filter(e => e.from && e.to)
        .map(e => `${e.from}>${e.to}|${e.label || ''}|${e.caseName ?? ''}`)
        .sort()
        .join('|');
    // Per-node heights are part of the SHAPE: an AI step that grew a tool row
    // pushes its vertical neighbours down, so a cached layout from before the
    // tool was attached is a different graph.
    const heights = heightById && heightById.size
        ? [...heightById.entries()].map(([id, h]) => `${id}:${h}`).sort().join(',')
        : '';
    // Spacing is part of the key or the LRU would hand a "compact" caller the
    // roomy layout it computed for the identical graph a moment earlier.
    return `${dims.width}x${dims.height}@${spacing.nodesep}/${spacing.ranksep}#${nodeIds}#${edgeKey}#${heights}`;
}

function rememberLayout(key: string, positionById: Map<string, Point>) {
    if (layoutCache.has(key)) layoutCache.delete(key);
    layoutCache.set(key, positionById);
    if (layoutCache.size > LAYOUT_CACHE_CAP) {
        // Drop the oldest entry — Maps preserve insertion order.
        const oldest = layoutCache.keys().next().value;
        if (oldest !== undefined) layoutCache.delete(oldest);
    }
}

/**
 * Lay every node out with dagre and return Map<id, {x, y}> in top-left
 * coordinates. Memoised on graph shape.
 */
export function runDagre(allSteps: GraphStep[], edges: GraphEdge[], dims: Dims, heightById: Map<string, number> | null = null, spacing: Spacing = DEFAULT_SPACING): Map<string, Point> {
    const gaps = spacing === DEFAULT_SPACING ? DEFAULT_SPACING : { ...DEFAULT_SPACING, ...spacing };
    const key = layoutCacheKey(allSteps, edges, dims, heightById, gaps);
    const cached = layoutCache.get(key);
    if (cached) {
        // LRU touch: re-insert so the hit promotes to most-recent.
        layoutCache.delete(key);
        layoutCache.set(key, cached);
        return cached;
    }

    const g = new dagre.graphlib.Graph();
    // ranksep is the gap BETWEEN cards along the flow; nodesep the gap between
    // SIBLINGS in the same rank — the stacked arms of a condition or switch.
    // See DEFAULT_SPACING for how the values were chosen.
    g.setGraph({ rankdir: 'LR', nodesep: gaps.nodesep, ranksep: gaps.ranksep, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    // Dagre centres nodes in their rank, so a taller box reserves the space
    // ABOVE as well as below. The callers that grow a box (an AI step with a
    // row of tools hanging off it) want the room underneath, so the extra
    // height is applied here and the top-left conversion below is done against
    // the node's OWN height — otherwise the card itself would drift upward.
    for (const s of allSteps) {
        g.setNode(s.id, { width: dims.width, height: heightById?.get(s.id) ?? dims.height });
    }
    for (const e of edges) {
        if (!e.from || !e.to) continue;
        g.setEdge(e.from, e.to);
    }
    dagre.layout(g);
    const out = new Map<string, Point>();
    for (const s of allSteps) {
        const n = g.node(s.id) || { x: 0, y: 0 };
        out.set(s.id, { x: n.x - dims.width / 2, y: n.y - (heightById?.get(s.id) ?? dims.height) / 2 });
    }
    rememberLayout(key, out);
    return out;
}

/**
 * Positions for a whole graph ({trigger, triggers?, steps, edges}) using the
 * same rule the canvas uses: saved coordinates verbatim when EVERY node has
 * one, dagre for the whole graph otherwise (a half-laid-out canvas is worse
 * than a re-laid-out one).
 *
 * @returns {Map<string, {x:number,y:number}>}
 */
export function graphPositions(graph: GraphLike | null | undefined, dims: Dims = { width: 240, height: 96 }): Map<string, Point> {
    const allSteps = graphNodes(graph);
    if (allSteps.length === 0) return new Map();
    if (allSteps.every(s => isFinitePos(s.position))) {
        return new Map(allSteps.map((s): [string, Point] => [s.id, { x: (s.position as Point).x, y: (s.position as Point).y }]));
    }
    return runDagre(allSteps, (graph?.edges || []).filter(e => e?.from && e?.to), dims);
}

/** Trigger + secondary triggers + steps, in the order the canvas renders them. */
export function graphNodes(graph: GraphLike | null | undefined): GraphStep[] {
    if (!graph) return [];
    return [
        graph.trigger,
        ...(Array.isArray(graph.triggers) ? graph.triggers : []),
        ...(Array.isArray(graph.steps) ? graph.steps : []),
    ].filter((s): s is GraphStep => Boolean(s && s.id));
}
