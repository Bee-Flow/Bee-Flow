/**
 * What changed between two spreadsheets: per tab, which columns and rows were
 * added or removed and which cells changed (value and formula).
 *
 * A sheet is a grid A..Z × 1..2000 (core/documents/sheetCells.js). Comparing
 * it cell by cell at the same address would call every cell below an inserted
 * row "changed", so the grid is ALIGNED first:
 *
 *   1. Tabs are matched by name; tabs left over on both sides are paired in
 *      order (a renamed tab), the rest are added or removed.
 *   2. Columns are matched by their header (the first row with anything in
 *      it) when every used header is unique on both sides; otherwise by
 *      letter. A column only one side has is added or removed.
 *   3. Rows are aligned on their content over the matched columns (LCS),
 *      and inside each gap rows that are still alike are paired: a paired
 *      row is a row with changed cells, the rest are added or removed rows.
 *
 * Values are the COMPUTED ones (shared/expr/sheet.mjs evaluateSheet, done by
 * the loader); a cell whose formula changed but whose value did not is still
 * changed. Bounded: every row is listed while the tab has at most
 * DOCUMENT_COMPARE_MAX_LISTED_ROWS rows (./limits.mts), past that only the
 * changed rows and their neighbours.
 * Pure: no I/O.
 */

import { alignSequences } from './align.mts';
import { compareLimits } from './limits.mts';

export interface SheetTabInput {
    name: string;
    /** Raw input per cell: { A1: '12', B1: '=A1*2' }. */
    cells: Record<string, string>;
    /** What each cell shows: { A1: '12', B1: '24' }. */
    display: Record<string, string>;
}
export interface SheetSide { tabs: SheetTabInput[] }

export type ColumnOp = 'equal' | 'added' | 'removed';
export interface ColumnPair { left: string | null; right: string | null; header: string; op: ColumnOp }

export type RowOp = 'equal' | 'changed' | 'added' | 'removed';
export interface CellChange {
    /** Index into `columns`. */
    col: number;
    op: 'changed' | 'added' | 'removed';
    before: string;
    after: string;
    beforeFormula?: string;
    afterFormula?: string;
}
export interface RowPair {
    op: RowOp;
    left: number | null;
    right: number | null;
    /** Display values aligned to `columns` ('' where that side has no such column or row). */
    before: string[];
    after: string[];
    cells: CellChange[];
}
export interface TabCompare {
    name: string;
    leftName: string | null;
    rightName: string | null;
    op: 'equal' | 'changed' | 'added' | 'removed';
    columns: ColumnPair[];
    rows: RowPair[];
    /** Rows left out of `rows` (unchanged, far from any change). */
    hiddenRows: number;
    stats: { cellsChanged: number; rowsAdded: number; rowsRemoved: number; columnsAdded: number; columnsRemoved: number };
}
export interface SheetCompareResult {
    family: 'sheet';
    tabs: TabCompare[];
    summary: { tabsChanged: number; tabsAdded: number; tabsRemoved: number; cellsChanged: number; rowsAdded: number; rowsRemoved: number; columnsAdded: number; columnsRemoved: number };
}

/**
 * Rows in the same gap always pair (best likeness first): a row edited in
 * place is the usual change in a sheet, and reading it as one removed and one
 * added row hides which cells moved. Only the surplus is added or removed.
 */
const ROW_PAIR_FLOOR = 0.01;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CELL = /^([A-Z])([1-9][0-9]{0,4})$/;

interface Grid {
    rows: number;
    usedCols: string[];
    value: (col: string, row: number) => string;
    raw: (col: string, row: number) => string;
}

function gridOf(tab: SheetTabInput | null): Grid {
    const cells = tab?.cells || {};
    const display = tab?.display || {};
    let rows = 0;
    const used = new Set<string>();
    for (const name of new Set([...Object.keys(cells), ...Object.keys(display)])) {
        const m = CELL.exec(name);
        if (!m) continue;
        const text = String(display[name] ?? cells[name] ?? '');
        if (!text && !cells[name]) continue;
        used.add(m[1]);
        rows = Math.max(rows, Number(m[2]));
    }
    return {
        rows,
        usedCols: LETTERS.filter((l) => used.has(l)),
        value: (col, row) => String(display[`${col}${row}`] ?? cells[`${col}${row}`] ?? ''),
        raw: (col, row) => String(cells[`${col}${row}`] ?? ''),
    };
}

function headerRow(g: Grid): number {
    for (let r = 1; r <= g.rows; r++) if (g.usedCols.some((c) => g.value(c, r).trim())) return r;
    return 0;
}

function alignColumns(a: Grid, b: Grid): ColumnPair[] {
    const ha = headerRow(a);
    const hb = headerRow(b);
    const headersOf = (g: Grid, h: number) => g.usedCols.map((c) => (h ? g.value(c, h).trim().toLowerCase() : ''));
    const la = headersOf(a, ha);
    const lb = headersOf(b, hb);
    const unique = (list: string[]) => list.every(Boolean) && new Set(list).size === list.length;
    if (la.length && lb.length && unique(la) && unique(lb)) {
        const steps = alignSequences(a.usedCols, b.usedCols, {
            keyA: (c) => la[a.usedCols.indexOf(c)] || null,
            keyB: (c) => lb[b.usedCols.indexOf(c)] || null,
            similarity: () => 0,
            minSimilarity: 1,
        });
        return steps.map((s) => {
            if (s.op === 'match' || s.op === 'pair') return { left: s.a, right: s.b, header: b.value(s.b, hb), op: 'equal' as const };
            if (s.op === 'delete') return { left: s.a, right: null, header: a.value(s.a, ha), op: 'removed' as const };
            return { left: null, right: s.b, header: b.value(s.b, hb), op: 'added' as const };
        });
    }
    // By letter: A..the last used column of either side.
    const last = Math.max(LETTERS.indexOf(a.usedCols[a.usedCols.length - 1] ?? ''), LETTERS.indexOf(b.usedCols[b.usedCols.length - 1] ?? ''));
    return LETTERS.slice(0, last + 1).map((c) => {
        const inA = a.usedCols.includes(c);
        const inB = b.usedCols.includes(c);
        const op: ColumnOp = inA && !inB ? 'removed' : (!inA && inB ? 'added' : 'equal');
        return { left: inA || op === 'equal' ? c : null, right: inB || op === 'equal' ? c : null, header: (hb ? b.value(c, hb) : '') || (ha ? a.value(c, ha) : ''), op };
    });
}

function rowValues(g: Grid, row: number | null, cols: Array<string | null>): string[] {
    return cols.map((c) => (c && row ? g.value(c, row) : ''));
}

function cellChanges(a: Grid, b: Grid, ar: number, br: number, columns: ColumnPair[]): CellChange[] {
    const out: CellChange[] = [];
    columns.forEach((col, i) => {
        if (col.op !== 'equal' || !col.left || !col.right) return;
        const before = a.value(col.left, ar);
        const after = b.value(col.right, br);
        const rawA = a.raw(col.left, ar);
        const rawB = b.raw(col.right, br);
        if (before === after && rawA === rawB) return;
        const op = !before && !rawA ? 'added' : (!after && !rawB ? 'removed' : 'changed');
        out.push({
            col: i, op, before, after,
            ...(rawA.startsWith('=') ? { beforeFormula: rawA } : {}),
            ...(rawB.startsWith('=') ? { afterFormula: rawB } : {}),
        });
    });
    return out;
}

function similarity(x: string[], y: string[]): number {
    let filled = 0;
    let same = 0;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (!x[i] && !y[i]) continue;
        filled++;
        if (x[i] === y[i]) same++;
    }
    return filled ? same / filled : 1;
}

/** Changed rows plus one unchanged neighbour each side, the rest counted. */
function trimRows(rows: RowPair[]): { rows: RowPair[]; hidden: number } {
    const max = compareLimits().maxListedRows;
    if (rows.length <= max) return { rows, hidden: 0 };
    const keep = rows.map((r) => r.op !== 'equal');
    const near = keep.map((k, i) => k || keep[i - 1] === true || keep[i + 1] === true);
    const kept = rows.filter((_, i) => near[i]).slice(0, max);
    return { rows: kept, hidden: rows.length - kept.length };
}

export function compareTab(left: SheetTabInput | null, right: SheetTabInput | null): TabCompare {
    const a = gridOf(left);
    const b = gridOf(right);
    const columns = alignColumns(a, b);
    const leftCols = columns.map((c) => c.left);
    const rightCols = columns.map((c) => c.right);
    const matched = columns.map((c) => c.op === 'equal');
    const keyOf = (vals: string[]) => vals.filter((_, i) => matched[i]).join('\u0001');
    const leftRows = Array.from({ length: a.rows }, (_, i) => ({ n: i + 1, vals: rowValues(a, i + 1, leftCols) }));
    const rightRows = Array.from({ length: b.rows }, (_, i) => ({ n: i + 1, vals: rowValues(b, i + 1, rightCols) }));
    const steps = alignSequences(leftRows, rightRows, {
        keyA: (r) => keyOf(r.vals),
        keyB: (r) => keyOf(r.vals),
        similarity: (x, y) => Math.max(ROW_PAIR_FLOOR, similarity(x.vals.filter((_, i) => matched[i]), y.vals.filter((_, i) => matched[i]))),
        minSimilarity: ROW_PAIR_FLOOR,
    });
    const rows: RowPair[] = steps.map((s) => {
        if (s.op === 'match' || s.op === 'pair') {
            const cells = cellChanges(a, b, s.a.n, s.b.n, columns);
            return { op: cells.length ? 'changed' : 'equal', left: s.a.n, right: s.b.n, before: s.a.vals, after: s.b.vals, cells };
        }
        if (s.op === 'delete') return { op: 'removed', left: s.a.n, right: null, before: s.a.vals, after: rowValues(b, null, rightCols), cells: [] };
        return { op: 'added', left: null, right: s.b.n, before: rowValues(a, null, leftCols), after: s.b.vals, cells: [] };
    });
    // A blank row on one side is no news: an added or removed row with nothing in it is left out.
    const meaningful = rows.filter((r) => r.op === 'equal' || r.op === 'changed' || [...r.before, ...r.after].some(Boolean));
    const stats = {
        cellsChanged: meaningful.reduce((n, r) => n + r.cells.length, 0),
        rowsAdded: meaningful.filter((r) => r.op === 'added').length,
        rowsRemoved: meaningful.filter((r) => r.op === 'removed').length,
        columnsAdded: columns.filter((c) => c.op === 'added').length,
        columnsRemoved: columns.filter((c) => c.op === 'removed').length,
    };
    const changed = stats.cellsChanged + stats.rowsAdded + stats.rowsRemoved + stats.columnsAdded + stats.columnsRemoved > 0;
    const trimmed = trimRows(meaningful);
    return {
        name: right?.name ?? left?.name ?? '',
        leftName: left?.name ?? null,
        rightName: right?.name ?? null,
        op: !left ? 'added' : (!right ? 'removed' : (changed ? 'changed' : 'equal')),
        columns,
        rows: trimmed.rows,
        hiddenRows: trimmed.hidden,
        stats,
    };
}

export function compareSheets(left: SheetSide, right: SheetSide): SheetCompareResult {
    const steps = alignSequences(left.tabs, right.tabs, {
        keyA: (t) => t.name.trim().toLowerCase() || null,
        keyB: (t) => t.name.trim().toLowerCase() || null,
        // Tabs left over on both sides pair in order: a renamed tab.
        similarity: () => 0.5,
        minSimilarity: 0.5,
    });
    const tabs = steps.map((s) => {
        if (s.op === 'match' || s.op === 'pair') return compareTab(s.a, s.b);
        if (s.op === 'delete') return compareTab(s.a, null);
        return compareTab(null, s.b);
    });
    const sum = (k: keyof TabCompare['stats']) => tabs.reduce((n, t) => n + (t.op === 'added' || t.op === 'removed' ? 0 : t.stats[k]), 0);
    return {
        family: 'sheet',
        tabs,
        summary: {
            tabsChanged: tabs.filter((t) => t.op === 'changed').length,
            tabsAdded: tabs.filter((t) => t.op === 'added').length,
            tabsRemoved: tabs.filter((t) => t.op === 'removed').length,
            cellsChanged: sum('cellsChanged'),
            rowsAdded: sum('rowsAdded'),
            rowsRemoved: sum('rowsRemoved'),
            columnsAdded: sum('columnsAdded'),
            columnsRemoved: sum('columnsRemoved'),
        },
    };
}
