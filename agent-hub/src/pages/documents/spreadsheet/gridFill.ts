// Filling and AutoSum as pure functions over "the raw text of a cell": they
// answer the cells to write, the grid sends them through its normal save path.

import * as fillModule from '@shared/expr/sheetFill.mjs';
import { cellName } from './sheetEngine';
import type { Range, Whole } from './sheetModel';

interface Block { c0: number; r0: number; c1: number; r1: number }
interface FillApi { fillBlock: (block: Block, direction: 'down' | 'right', raw: (col: number, row: number) => string) => Record<string, string> }
const { fillBlock } = fillModule as unknown as FillApi;

export type RawAt = (col: number, row: number) => string;
export type IsNumber = (col: number, row: number) => boolean;

/**
 * Ctrl+D / Ctrl+R: the first row (column) of the selection over the rest. A
 * single row (column) fills from the one before it, as spreadsheets do. Only
 * cells whose text changes are answered.
 */
export function fillChanges(r: Range, direction: 'down' | 'right', raw: RawAt): Record<string, string> {
    const down = direction === 'down';
    const block: Block = { c0: r.c1, r0: r.r1, c1: r.c2, r1: r.r2 };
    if (down && r.r1 === r.r2) block.r0 = r.r1 - 1;
    if (!down && r.c1 === r.c2) block.c0 = r.c1 - 1;
    if (block.r0 < 0 || block.c0 < 0) return {};
    const filled = fillBlock(block, direction, raw);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(filled)) {
        const at = /^([A-Z]+)(\d+)$/.exec(name);
        if (!at) continue;
        if (value !== raw(at[1].charCodeAt(0) - 65, Number(at[2]) - 1)) out[name] = value;
    }
    return out;
}

const ref = (col: number, from: number, to: number) => (from === to
    ? cellName(col, from)
    : `${cellName(col, from)}:${cellName(col, to)}`);

/** The first row of the run of numbers that ends at `end` (inclusive), or `end + 1` when there is none. */
function runStart(end: number, isNum: (i: number) => boolean): number {
    let i = end;
    while (i >= 0 && isNum(i)) i--;
    return i + 1;
}

/** One cell: the numbers right above it, else the numbers to its left. */
function sumBeside(col: number, row: number, isNum: IsNumber): Record<string, string> {
    const up = runStart(row - 1, (i) => isNum(col, i));
    if (up <= row - 1) return { [cellName(col, row)]: `=SUM(${ref(col, up, row - 1)})` };
    const left = runStart(col - 1, (i) => isNum(i, row));
    if (left > col - 1) return {};
    const range = left === col - 1 ? cellName(left, row) : `${cellName(left, row)}:${cellName(col - 1, row)}`;
    return { [cellName(col, row)]: `=SUM(${range})` };
}

/** A column of the selection: the SUM of the cells above `target` goes into it. */
function sumInto(col: number, from: number, target: number, isNum: IsNumber): Record<string, string> {
    for (let row = from; row < target; row++) {
        if (isNum(col, row)) return { [cellName(col, target)]: `=SUM(${ref(col, from, target - 1)})` };
    }
    return {};
}

/**
 * Alt+=. On one empty cell: SUM of the numbers directly above (else to the
 * left). On a block whose last row is empty: the SUM of the rows above, per
 * column. On whole columns: under the used rows.
 */
export function autoSumChanges(r: Range, whole: Whole, usedRows: number, raw: RawAt, isNum: IsNumber): Record<string, string> {
    if (whole === 'rows') return {};
    if (whole === 'columns') {
        if (usedRows < 1 || usedRows >= 2000) return {};
        let out: Record<string, string> = {};
        for (let c = r.c1; c <= r.c2; c++) out = { ...out, ...sumInto(c, 0, usedRows, isNum) };
        return out;
    }
    if (r.c1 === r.c2 && r.r1 === r.r2) return raw(r.c1, r.r1) === '' ? sumBeside(r.c1, r.r1, isNum) : {};
    let out: Record<string, string> = {};
    for (let c = r.c1; c <= r.c2 && r.r2 > r.r1; c++) {
        if (raw(c, r.r2) === '') out = { ...out, ...sumInto(c, r.r1, r.r2, isNum) };
    }
    return out;
}
