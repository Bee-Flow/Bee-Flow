// @typecheck
/**
 * Cell references for the spreadsheet assistant: a range as a list of cells,
 * and a formula FILLED over a range (shared/expr/sheetFill.mjs shifts it per
 * cell, exactly as the grid's own fill-down does). That is what lets the
 * assistant write one formula for a whole column instead of 500 of them.
 *
 * Bounds are this product's sheet: columns A–Z, rows 1–MAX_ROWS.
 */

'use strict';

const MAX_COLS = 26;
const MAX_ROWS = 2000;

const colName = (/** @type {number} */ c) => String.fromCharCode(65 + c);

/**
 * 'B3' → { col: 1, row: 2 } (0-based), or null outside A1:Z{MAX_ROWS}.
 * @param {string} name
 */
function parseCell(name) {
    const m = /^\$?([A-Z])\$?([1-9]\d{0,4})$/.exec(String(name || '').trim().toUpperCase());
    if (!m) return null;
    const row = Number(m[2]) - 1;
    if (row >= MAX_ROWS) return null;
    return { col: m[1].charCodeAt(0) - 65, row };
}

/**
 * 'B2:D9' (any corner order), or a single cell, → the rectangle; null when
 * malformed or out of the sheet.
 * @param {string} range
 * @returns {{ c0: number, r0: number, c1: number, r1: number } | null}
 */
function parseRange(range) {
    const parts = String(range || '').trim().toUpperCase().split(':');
    if (parts.length > 2) return null;
    const a = parseCell(parts[0]);
    const b = parts.length === 2 ? parseCell(parts[1]) : a;
    if (!a || !b) return null;
    return { c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row), c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row) };
}

/** Every cell name in a rectangle, row by row. */
function cellsIn(/** @type {{ c0: number, r0: number, c1: number, r1: number }} */ r) {
    const out = [];
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) out.push(`${colName(col)}${row + 1}`);
    return out;
}

/** Shared with the grid's fill-down (shared/expr/sheetFill.mjs): one way to shift a formula. */
const { shiftFormula } = require('../../../shared/expr/sheetFill.mjs');

/**
 * Fill `formula`, written as it reads in the range's FIRST cell, over every
 * cell of the range.
 *
 * @param {string} range
 * @param {string} formula
 * @returns {Record<string, string> | null} null for a malformed range
 */
function fillRange(range, formula) {
    const r = parseRange(range);
    if (!r) return null;
    /** @type {Record<string, string>} */
    const out = {};
    for (let row = r.r0; row <= r.r1; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
            out[`${colName(col)}${row + 1}`] = shiftFormula(formula, col - r.c0, row - r.r0);
        }
    }
    return out;
}

module.exports = { parseCell, parseRange, cellsIn, shiftFormula, fillRange, colName, MAX_COLS, MAX_ROWS };
