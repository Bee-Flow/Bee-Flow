// Pure helpers of the grid: ranges, the cells a formula reads, and the
// tab-separated text that copy and paste exchange with other spreadsheets.

import { cellName, parseCellRef } from './sheetEngine';

export interface Pos { col: number; row: number }
export interface Range { c1: number; r1: number; c2: number; r2: number }

/** What the selection is: one cell, a block, whole rows or whole columns. */
export type SelectionKind = 'cell' | 'range' | 'rows' | 'columns';
export type Whole = 'rows' | 'columns' | null;

export const COLUMNS = 26;
/** The server takes selections inside A1:Z{MAX_ROWS}. */
export const MAX_ROWS = 2000;
/** Never show fewer rows than this, and always this many beyond the last used one. */
export const MIN_ROWS = 50;
export const ROWS_MARGIN = 20;
export const ADD_ROWS = 50;

export function rangeOf(a: Pos, b: Pos): Range {
    return { c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row), c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row) };
}

/** The selected block; whole columns / rows run over every visible row / column. */
export function effectiveRange(anchor: Pos, focus: Pos, whole: Whole, columns: number, rows: number): Range {
    const r = rangeOf(anchor, focus);
    if (whole === 'columns') return { ...r, r1: 0, r2: Math.max(rows - 1, 0) };
    if (whole === 'rows') return { ...r, c1: 0, c2: Math.max(columns - 1, 0) };
    return r;
}

export function kindOf(r: Range, whole: Whole): SelectionKind {
    if (whole) return whole;
    return r.c1 === r.c2 && r.r1 === r.r2 ? 'cell' : 'range';
}

/** The selection cut down to what holds data: whole columns to the used rows, whole rows to the used columns. */
export function clipToUsed(r: Range, whole: Whole, usedRows: number, usedCols: number): Range {
    if (whole === 'columns') return { ...r, r2: Math.min(r.r2, Math.max(usedRows, 1) - 1) };
    if (whole === 'rows') return { ...r, c2: Math.min(r.c2, Math.max(usedCols, 1) - 1) };
    return r;
}

/**
 * The selection as the assistant takes it, always a bounded A1 range: whole
 * columns end at the last used row ("C1:C12"), whole rows run over the sheet's
 * width ("A3:Z5").
 */
export function selectionFor(r: Range, kind: SelectionKind, usedRows: number, columns: number): string {
    const last = Math.min(r.r2 + 1, MAX_ROWS);
    if (kind === 'columns') return `${cellName(r.c1, 0)}:${cellName(r.c2, Math.min(Math.max(usedRows, 1), MAX_ROWS) - 1)}`;
    if (kind === 'rows') return `${cellName(0, r.r1)}:${cellName(Math.max(columns - 1, 0), last - 1)}`;
    const from = cellName(r.c1, r.r1);
    return kind === 'cell' ? from : `${from}:${cellName(r.c2, last - 1)}`;
}

/** How many columns hold data (the last used column, 1-based). */
export function usedColsOf(cells: Record<string, string>): number {
    let max = 0;
    for (const name of Object.keys(cells)) {
        if (cells[name] === '') continue;
        const p = parseCellRef(name);
        if (p && p.col + 1 > max) max = p.col + 1;
    }
    return max;
}

export function inRange(r: Range, col: number, row: number): boolean {
    return col >= r.c1 && col <= r.c2 && row >= r.r1 && row <= r.r2;
}

/** The last used row (1-based count) among the cells. */
export function usedRowsOf(cells: Record<string, string>, fromServer = 0): number {
    let max = fromServer;
    for (const name of Object.keys(cells)) {
        if (cells[name] === '') continue;
        const p = parseCellRef(name);
        if (p && p.row + 1 > max) max = p.row + 1;
    }
    return max;
}

const REF = /(?<![\w.$])\$?([A-Z]{1,2})\$?(\d+)(?::\$?([A-Z]{1,2})\$?(\d+))?(?![\w(])/g;
const MAX_REFERENCED = 3000;

/** The names of the cells a formula reads (ranges expanded). Empty for a non-formula. */
export function referencedNames(raw: string): Set<string> {
    const out = new Set<string>();
    if (!raw.startsWith('=')) return out;
    const text = raw.replace(/"[^"]*"/g, '""').toUpperCase();
    for (const m of text.matchAll(REF)) {
        const a = parseCellRef(`${m[1]}${m[2]}`);
        const b = m[3] ? parseCellRef(`${m[3]}${m[4]}`) : a;
        if (!a || !b) continue;
        const r = rangeOf(a, b);
        for (let row = r.r1; row <= r.r2 && out.size < MAX_REFERENCED; row++) {
            for (let col = r.c1; col <= r.c2 && out.size < MAX_REFERENCED; col++) out.add(cellName(col, row));
        }
    }
    return out;
}

/** Tab-separated text (rows by newline); a field with a tab, newline or quote is quoted, as spreadsheets do. */
export function toTsv(rows: string[][]): string {
    const field = (v: string) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return rows.map((r) => r.map(field).join('\t')).join('\n');
}

/** The inverse of toTsv; also reads what Excel and Google Sheets put on the clipboard. */
export function parseTsv(text: string): string[][] {
    const s = text.replace(/\r\n?/g, '\n');
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let atStart = true;
    const endField = () => { row.push(field); field = ''; atStart = true; };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quoted) {
            if (ch !== '"') field += ch;
            else if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else if (ch === '"' && atStart) { quoted = true; atStart = false; }
        else if (ch === '\t') endField();
        else if (ch === '\n') { endField(); rows.push(row); row = []; }
        else { field += ch; atStart = false; }
    }
    if (field !== '' || row.length) { endField(); rows.push(row); }
    return rows;
}
