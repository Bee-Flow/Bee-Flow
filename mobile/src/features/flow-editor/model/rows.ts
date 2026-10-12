/**
 * The row layout: dagre ranks the graph, then the ranks are cut into rows
 * that read left to right like text. A port of the row half of the web
 * builder's flow/arrange.js, pinned by layout.lockstep.test.ts.
 *
 * Cutting between two single-node ranks splits a plain chain, which reads
 * fine; cutting inside a fan-out puts a Condition on one row and its arms on
 * the next, so those boundaries are avoided unless there is no alternative.
 */

import { toolLayoutHeights } from './geometry';
import { DEFAULT_DIMS, DEFAULT_SPACING, runDagre, type Dims, type Spacing } from './layout';
import type { AnyNode, FlowEdge, Position } from './types';

/** Steps per row when nothing (no viewport) says otherwise — the design's five. */
export const DEFAULT_COLUMNS = 5;
/** Vertical gap between two wrapped rows; the return edge runs through it. */
export const ROW_GAP = 270;

interface Member {
    id: string;
    x: number;
    y: number;
}
type Rank = Member[];

/** Group dagre's output into ranks: with rankdir LR, a rank shares an x. */
export function toRanks(nodes: Pick<AnyNode, 'id'>[], positionById: Map<string, Position>): Rank[] {
    const byX = new Map<number, Rank>();
    for (const s of nodes) {
        const p = positionById.get(s.id);
        if (!p) continue;
        const key = Math.round(p.x);
        const rank = byX.get(key) ?? [];
        rank.push({ id: s.id, x: p.x, y: p.y });
        byX.set(key, rank);
    }
    return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([, members]) => members.sort((a, b) => a.y - b.y));
}

function breakableBoundaries(ranks: Rank[]): boolean[] {
    const ok = new Array<boolean>(ranks.length).fill(false);
    for (let i = 1; i < ranks.length; i += 1) {
        ok[i] = (ranks[i - 1] as Rank).length === 1 && (ranks[i] as Rank).length === 1;
    }
    return ok;
}

/** The cut for the row starting at `start`: backwards from the target, then forwards, then the target. */
function cutFor(breakable: boolean[], start: number, target: number, total: number): number {
    for (let i = target; i > start + 1; i -= 1) if (breakable[i]) return i;
    for (let i = target + 1; i < total; i += 1) if (breakable[i]) return i;
    return target;
}

/** Chunk ranks into rows of at most `maxCols`; never an empty row. */
export function chunkRanks(ranks: Rank[], maxCols: number): Rank[][] {
    const breakable = breakableBoundaries(ranks);
    const rows: Rank[][] = [];
    let start = 0;
    while (start < ranks.length) {
        const target = Math.min(start + maxCols, ranks.length);
        if (target >= ranks.length) {
            rows.push(ranks.slice(start));
            break;
        }
        let cut = cutFor(breakable, start, target, ranks.length);
        if (cut <= start) cut = target;
        rows.push(ranks.slice(start, cut));
        start = cut;
    }
    return rows;
}

function rowExtent(row: Rank[], heightById: Map<string, number>, dims: Dims): { minY: number; height: number } | null {
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

/** The bounding box a row split would occupy: n columns span n-1 gaps plus one card. */
export function measureRows(rows: Rank[][], heightById: Map<string, number>, dims: Dims, colWidth: number) {
    let width = 0;
    let height = 0;
    rows.forEach((row, i) => {
        width = Math.max(width, (row.length - 1) * colWidth + dims.width);
        const ext = rowExtent(row, heightById, dims);
        height += (ext?.height || dims.height) + (i < rows.length - 1 ? ROW_GAP : 0);
    });
    return { width: Math.max(width, dims.width), height: Math.max(height, dims.height) };
}

/** Place chunked rows; every row reads left to right, the next starts below the last. */
export function placeRows(rows: Rank[][], heightById: Map<string, number>, dims: Dims, colWidth: number): Map<string, Position> {
    const out = new Map<string, Position>();
    let rowTop = 0;
    rows.forEach((row) => {
        const ext = rowExtent(row, heightById, dims);
        if (!ext) return;
        row.forEach((rank, col) => {
            for (const m of rank) out.set(m.id, { x: col * colWidth, y: rowTop + (m.y - ext.minY) });
        });
        rowTop += ext.height + ROW_GAP;
    });
    return out;
}

export interface RowLayoutOptions {
    dims?: Dims;
    spacing?: Spacing;
    cols?: number;
    heightById?: Map<string, number> | null;
}

/**
 * The viewport-free row layout: dagre for the ranking, then rows of a fixed
 * width. What every node without a position gets, so an automation built step by
 * step grows into rows.
 */
export function rowLayoutPositions(
    nodes: AnyNode[] | null | undefined,
    edges: FlowEdge[],
    { dims = DEFAULT_DIMS, spacing = DEFAULT_SPACING, cols = DEFAULT_COLUMNS, heightById = null }: RowLayoutOptions = {},
): Map<string, Position> {
    if (!nodes || nodes.length === 0) return new Map();
    const heights = heightById || toolLayoutHeights(nodes, dims.height);
    const flat = runDagre(nodes, edges, { dims, heightById: heights, spacing });
    const ranks = toRanks(nodes, flat);
    if (ranks.length === 0) return new Map();
    const colWidth = dims.width + spacing.ranksep;
    return placeRows(chunkRanks(ranks, Math.max(1, cols)), heights, dims, colWidth);
}
