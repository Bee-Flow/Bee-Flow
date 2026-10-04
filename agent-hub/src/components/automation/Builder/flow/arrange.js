import { toolLayoutHeights } from './aiToolNodes';
import { DEFAULT_SPACING, graphNodes, runDagre } from './dagreLayout';
import { isInlineId } from './inlineFlowlets';
import { ROW_GAP } from './rowBands';

/**
 * "Arrange" — the button that gives a canvas its shape back.
 *
 * Positions live on each step (`step.position`), and buildLayout/seedPositions
 * follow an all-or-nothing rule: the moment EVERY node has a position, dagre is
 * never consulted again. That rule is right for normal editing — nobody wants
 * their arrangement thrown away because a node was added — but it means one
 * drag permanently retires the automatic layout. This module is the deliberate
 * way back.
 *
 * So, unlike `seedPositions`, everything here OVERWRITES. That is the whole
 * point, and it is why `seedPositions` cannot be reused: it early-returns in
 * exactly the case the user pressed the button for.
 *
 * Safety net: the caller commits the result through the normal draft-history
 * path, so one Arrange is one Ctrl+Z.
 *
 * Builder redesign (Sep 2026): ROWS are the default shape. `rowLayoutPositions`
 * is the viewport-free variant of the serpentine — a fixed column count, the
 * design's five per row — and it is what layout.js uses for every node that
 * has no position yet, so a NEW automation grows into rows step by step while an
 * existing one keeps its hand-placed positions until Arrange is pressed.
 */

export const ARRANGE_MODES = Object.freeze(['compact', 'roomy', 'serpentine']);

export const DEFAULT_DIMS = Object.freeze({ width: 240, height: 96 });

/** Steps per row when nothing (no viewport) says otherwise — design 1a. */
export const DEFAULT_COLUMNS = 5;

/**
 * Per-mode gaps.
 *
 * The gap between two cards is not empty: it is where the connection's badges
 * live — "1 record", a branch name, "otherwise", the add button. dagreLayout
 * settled on DEFAULT_SPACING as the point where those badges stop overlapping
 * the cards on either side. That makes DEFAULT_SPACING a FLOOR, not a default:
 * "compact" means the tightest arrangement that is still readable, and going
 * under it does not buy a tighter canvas, only a smeared one.
 *
 * So the tightening modes sit exactly on the floor and `roomy` goes above it —
 * it is the mode you pick with the flowlets open, and an expanded container is
 * several times the size of the card this floor was measured against.
 */
const SPACING = Object.freeze({
    compact: { nodesep: DEFAULT_SPACING.nodesep, ranksep: DEFAULT_SPACING.ranksep },
    roomy: { nodesep: 88, ranksep: 140 },
    serpentine: { nodesep: DEFAULT_SPACING.nodesep, ranksep: DEFAULT_SPACING.ranksep },
});

/**
 * Nodes that take part in a layout: real, positionable, not folded-in inline
 * copies — and not a note (BFSF-411). A note carries no edges, so dagre has
 * nothing to rank it against and would drop it wherever a disconnected node
 * lands; excluding it from the layout pass entirely (rather than just from
 * `layoutEdges`) is what keeps `applyPositions` from touching it at all —
 * free-floating means Arrange leaves it exactly where the author put it.
 */
function layoutNodes(graph) {
    return graphNodes(graph).filter(s => !isInlineId(s.id) && s.type !== 'note');
}

function layoutEdges(graph) {
    return (graph?.edges || []).filter(e => e?.from && e?.to && !isInlineId(e.from) && !isInlineId(e.to));
}

/**
 * Group dagre's output into ranks. With `rankdir: 'LR'` every node in a rank
 * shares an x, and all cards are the same width, so the top-left x IS the rank
 * key — no need to reach into dagre's internals for it.
 */
function toRanks(nodes, positionById) {
    const byX = new Map();
    for (const s of nodes) {
        const p = positionById.get(s.id);
        if (!p) continue;
        const key = Math.round(p.x);
        if (!byX.has(key)) byX.set(key, []);
        byX.get(key).push({ id: s.id, x: p.x, y: p.y });
    }
    return [...byX.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, members]) => members.sort((a, b) => a.y - b.y));
}

/**
 * Where a row may be cut.
 *
 * Cutting between two ranks that each hold a single node splits a plain chain,
 * which reads fine. Cutting inside a fan-out puts a Condition on one row and
 * its two arms on the next, which reads worse than the long line we set out to
 * fix — so those boundaries are avoided unless there is no alternative.
 */
function breakableBoundaries(ranks) {
    const ok = new Array(ranks.length).fill(false);
    for (let i = 1; i < ranks.length; i += 1) {
        ok[i] = ranks[i - 1].length === 1 && ranks[i].length === 1;
    }
    return ok;
}

/**
 * Chunk ranks into rows of at most `maxCols`, preferring a breakable boundary
 * near the target width. Walks backwards from the target first (a slightly
 * short row beats a broken branch), then forwards, then gives up and cuts at
 * the target — never returning an empty row, so this always terminates.
 */
function chunkRanks(ranks, maxCols) {
    const breakable = breakableBoundaries(ranks);
    const rows = [];
    let start = 0;
    while (start < ranks.length) {
        const target = Math.min(start + maxCols, ranks.length);
        if (target >= ranks.length) { rows.push(ranks.slice(start)); break; }
        let cut = -1;
        for (let i = target; i > start + 1; i -= 1) { if (breakable[i]) { cut = i; break; } }
        if (cut === -1) {
            for (let i = target + 1; i < ranks.length; i += 1) { if (breakable[i]) { cut = i; break; } }
        }
        if (cut === -1 || cut <= start) cut = target;
        rows.push(ranks.slice(start, cut));
        start = cut;
    }
    return rows;
}

/** Vertical extent of one row, so the next row can start below all of it. */
function rowExtent(row, heightById, dims) {
    let minY = Infinity;
    let maxBottom = -Infinity;
    for (const rank of row) {
        for (const m of rank) {
            minY = Math.min(minY, m.y);
            maxBottom = Math.max(maxBottom, m.y + (heightById.get(m.id) ?? dims.height));
        }
    }
    return Number.isFinite(minY) ? { minY, height: maxBottom - minY } : null;
}

/**
 * Bounding box a given row split would occupy, without placing anything.
 *
 * n columns span (n-1) gaps plus one card — NOT n colWidths. The difference is
 * a whole column gap of phantom width on every candidate, and since the choice
 * below is made on the box's RATIO, that phantom is enough to hand the job to
 * the wrong grid.
 */
function measureRows(rows, heightById, dims, colWidth) {
    let width = 0;
    let height = 0;
    rows.forEach((row, i) => {
        width = Math.max(width, (row.length - 1) * colWidth + dims.width);
        const ext = rowExtent(row, heightById, dims);
        height += (ext?.height || dims.height) + (i < rows.length - 1 ? ROW_GAP : 0);
    });
    return { width: Math.max(width, dims.width), height: Math.max(height, dims.height) };
}

/**
 * How many columns to wrap at.
 *
 * Counting how many cards fit across the viewport is the obvious answer and
 * the wrong one: `fitView` rescales the result afterwards, so what actually
 * decides whether the flow fills the screen is the SHAPE of the bounding box,
 * not its size. Matching the viewport's aspect ratio is what makes a wrapped
 * flow use the whole canvas instead of a letterboxed strip of it.
 *
 * Without a viewport there is nothing to match, so fall back to the design's
 * fixed row width (DEFAULT_COLUMNS) rather than guessing two columns.
 */
function chooseColumns(ranks, { heightById, dims, colWidth, viewportWidth, viewportHeight }) {
    if (!viewportWidth || !viewportHeight) {
        if (!viewportWidth) return DEFAULT_COLUMNS;
        const usable = Math.max(colWidth, viewportWidth - dims.width);
        return Math.max(2, Math.floor(usable / colWidth));
    }
    const target = viewportWidth / viewportHeight;
    let best = ranks.length;
    let bestErr = Infinity;
    for (let cols = 2; cols <= ranks.length; cols += 1) {
        const { width, height } = measureRows(chunkRanks(ranks, cols), heightById, dims, colWidth);
        const err = Math.abs((width / height) - target);
        if (err < bestErr) { bestErr = err; best = cols; }
    }
    return Math.max(2, best);
}

/**
 * Place chunked rows. Every row reads left to right, like text: the flow
 * reaches the right-hand edge, and the next step carries on from the left of
 * the row below. The alternative — ploughing back the other way, so row two
 * reads right to left — gives shorter connectors and was tried first, but on a
 * numbered automation it puts step 10 to the left of step 6 and the canvas
 * becomes unreadable in the one place it was meant to be readable. The long
 * return edge is the price of a canvas you can read in order, and ROW_GAP
 * leaves it a lane to run in.
 */
function placeRows(rows, heightById, dims, colWidth) {
    const out = new Map();
    let rowTop = 0;
    rows.forEach((row) => {
        const ext = rowExtent(row, heightById, dims);
        if (!ext) return;
        row.forEach((rank, col) => {
            for (const m of rank) {
                out.set(m.id, { x: col * colWidth, y: rowTop + (m.y - ext.minY) });
            }
        });
        rowTop += ext.height + ROW_GAP;
    });
    return out;
}

/** Fold a long left-to-right chain into rows that fit the viewport. */
function serpentinePositions(nodes, edges, { dims, spacing, viewportWidth, viewportHeight }) {
    const heightById = toolLayoutHeights(nodes, dims.height);
    const flat = runDagre(nodes, edges, dims, heightById, spacing);
    const ranks = toRanks(nodes, flat);
    if (ranks.length === 0) return new Map();

    const colWidth = dims.width + spacing.ranksep;
    const rows = chunkRanks(ranks, chooseColumns(ranks, {
        heightById, dims, colWidth, viewportWidth, viewportHeight,
    }));
    return placeRows(rows, heightById, dims, colWidth);
}

/**
 * The viewport-free row layout: dagre for the ranking, then rows of a fixed
 * width. Used by layout.js for every node that has no position yet — so
 * building an automation step by step grows rows, without any caller having to
 * know how wide the canvas is (seedPositions runs from pure handlers with no
 * viewport at all). A graph shorter than one row comes out exactly as dagre
 * placed it, just re-based to the top-left.
 *
 * @param {Array} nodes      top-level, positionable steps (see layoutNodes)
 * @param {Array} edges      their edges
 * @param {object} opts      { dims, spacing, cols, heightById }
 * @returns {Map<string,{x:number,y:number}>}
 */
export function rowLayoutPositions(nodes, edges, {
    dims = DEFAULT_DIMS, spacing = DEFAULT_SPACING, cols = DEFAULT_COLUMNS, heightById = null,
} = {}) {
    if (!nodes || nodes.length === 0) return new Map();
    const heights = heightById || toolLayoutHeights(nodes, dims.height);
    const flat = runDagre(nodes, edges, dims, heights, spacing);
    const ranks = toRanks(nodes, flat);
    if (ranks.length === 0) return new Map();
    const colWidth = dims.width + spacing.ranksep;
    return placeRows(chunkRanks(ranks, Math.max(1, cols)), heights, dims, colWidth);
}

/** Positions for one graph in the requested mode. */
function positionsFor(graph, mode, opts) {
    const nodes = layoutNodes(graph);
    if (nodes.length === 0) return new Map();
    const edges = layoutEdges(graph);
    const spacing = SPACING[mode] || SPACING.roomy;
    const { dims } = opts;
    if (mode === 'serpentine') return serpentinePositions(nodes, edges, { ...opts, spacing });
    return runDagre(nodes, edges, dims, toolLayoutHeights(nodes, dims.height), spacing);
}

/**
 * Write positions onto a graph's trigger(s) and steps. Inline nodes keep what
 * they have: their coordinates belong to another graph entirely.
 */
function applyPositions(graph, positionById) {
    if (!graph) return graph;
    const apply = (s) => {
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

/**
 * Re-lay-out a whole definition.
 *
 * @param def            the scope graph being edited ({trigger, steps, edges, layers})
 * @param mode           'compact' | 'roomy' | 'serpentine'
 * @param dims           card size estimate; must match what the canvas renders
 * @param viewportWidth  serpentine only — the canvas viewport, used to pick
 * @param viewportHeight   how many columns to wrap at
 * @param includeLayers  also tidy the inside of every flowlet. On for 'roomy'
 *                       (the mode you pick to look at expanded flowlets),
 *                       otherwise off: rearranging a flowlet you cannot see is
 *                       a surprise, and it still costs an undo entry.
 */
export function arrangeDefinition(def, {
    mode = 'roomy',
    dims = DEFAULT_DIMS,
    viewportWidth = 0,
    viewportHeight = 0,
    includeLayers = null,
} = {}) {
    if (!def || !def.trigger) return def;
    const useMode = ARRANGE_MODES.includes(mode) ? mode : 'roomy';
    const opts = { dims, viewportWidth, viewportHeight };
    const next = applyPositions(def, positionsFor(def, useMode, opts));

    const withLayers = includeLayers === null ? useMode === 'roomy' : includeLayers;
    const layers = withLayers ? arrangeLayers(def.layers, useMode, opts) : null;
    return layers ? { ...next, layers } : next;
}

/** Tidy the inside of every flowlet. Returns null when there is nothing to do. */
function arrangeLayers(source, mode, opts) {
    if (!source || typeof source !== 'object') return null;
    const layers = {};
    let touched = false;
    for (const [key, layer] of Object.entries(source)) {
        if (layer?.trigger) {
            layers[key] = applyPositions(layer, positionsFor(layer, mode, opts));
            touched = true;
        } else {
            layers[key] = layer;
        }
    }
    return touched ? layers : null;
}
