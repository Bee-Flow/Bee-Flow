/**
 * tables.js — table model helpers + structural commands.
 *
 * MERGED CELLS: every structural operation here works in VISUAL grid
 * coordinates, not array indices. colspan/rowspan are supported everywhere else
 * in the stack (schema, htmlToAst, render, reconcile, astToHtml, astToMd's
 * `{cs= rs=}` marker) but this module used to treat a row's array index as its
 * column number. In any table with a merged cell that meant: deleting a row left
 * a rowspan overflowing the table, adding a column slid data under the wrong
 * header, deleting a column silently did nothing on short rows, and Tab skipped
 * cells while appending endless new rows.
 */
import { getNode, updateAt, parentPath, type UpdatedNode } from './doc';
import { node, emptyParagraph } from '../model/nodes.js';
import { textSelection, nodeSelection, cellSelection, pos, isCell } from './selection.js';
import { type DocNode } from '../model/schema.js';
import { colLabel } from './formulaRefs.js';
import { remapFormulasInTable } from './formulaRemap.js';
import type { Selection } from './selection';
import type { EditorState } from './state.js';
import type { Grid } from './tables.types';
import { st, spanOf, tableGrid, entryFor, ownColOf, distinctEntries, withSpan, makeCell, tableContext, ctxFromState, addRow, addColumn, deleteTable, withCaretAt, cellRect, cellText } from './tables.helpers.js';
export { tableGrid, makeCell, tableContext, addRowAfter, setCellFormula, deleteColumn, deleteColumnAt, deleteTable, goToCell, cellRect } from './tables.helpers.js';

/* ── visual grid ────────────────────────────────────────── */

export function makeRow(cols: number, header: boolean) {
  return node('tableRow', null, Array.from({ length: cols }, () => makeCell(header)));
}
export function makeTable(rows: number, cols: number, withHeaderRow: boolean) {
  const out = [];
  for (let r = 0; r < rows; r++) out.push(makeRow(cols, withHeaderRow && r === 0));
  return node('table', null, out);
}

export function addRowBefore(state: EditorState) { return addRow(state, 0); }

export function addColumnAfter(state: EditorState) { return addColumn(state, 1); }
export function addColumnBefore(state: EditorState) { return addColumn(state, 0); }

/** Append a row at the end of the table containing the selection. */
export function appendRow(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const { cols } = tableGrid(table);           // visual width, not row 0's array length
  const newRow = makeRow(Math.max(1, cols), false);
  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({ ...t, content: [...t.content, newRow] }));
  const newRowIdx = getNode(doc2, ctx.tablePath).content.length - 1;
  return st(doc2, textSelection(pos([...ctx.tablePath, newRowIdx, 0, 0], 0)));
}

/** Append a column at the right edge of the table containing the selection. */
export function appendColumn(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const headerRow = !!table.content[0]?.content?.[0]?.attrs?.header;
  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({
    ...t,
    content: t.content.map((row, r) => ({ ...row, content: [...row.content, makeCell(r === 0 && headerRow)] })),
  }));
  const lastCol = getNode(doc2, ctx.tablePath).content[ctx.rowIdx].content.length - 1;
  return st(doc2, textSelection(pos([...ctx.tablePath, ctx.rowIdx, lastCol, 0], 0)));
}

/**
 * Append a total row and put `=SUM(<col-range>)` in visual column `col`.
 *
 * The range is explicit (`B2:B4`), not the whole column (`B:B`): a whole-column
 * range would include the total row itself and evaluate to #CIRC!. Row 1 is
 * skipped when the table has a header row; the range's last row is the row
 * count BEFORE the append.
 */
export function addColumnTotal(state: EditorState, tablePath: number[], col: number) {
  const table = getNode(state.doc, tablePath);
  if (!table || table.type !== 'table') return state;
  const { rows, cols } = tableGrid(table);
  if (!cols || col == null || col < 0 || col >= cols) return state;
  const hasHeader = !!table.content[0]?.content?.[0]?.attrs?.header;
  const first = hasHeader ? 2 : 1;               // 1-based first data row
  const last = rows;                              // 1-based last row before the append
  if (last < first) return state;                 // nothing to total
  const letter = colLabel(col);
  const src = `=SUM(${letter}${first}:${letter}${last})`;

  // Same width mechanics as appendRow: a fresh full-width row at the end.
  const newRow = makeRow(Math.max(1, cols), false);
  const doc2 = updateAt(state.doc, tablePath, (t) => ({ ...t, content: [...t.content, newRow] }));
  const t2 = getNode(doc2, tablePath);
  const newRowIdx = t2.content.length - 1;
  const { grid } = tableGrid(t2);
  const e = grid[newRowIdx]?.[col];
  const cellIdx = e && e.rowIdx === newRowIdx
    ? e.cellIdx
    : Math.max(0, Math.min(col, (t2.content[newRowIdx]?.content?.length || 1) - 1));
  const cellPath = [...tablePath, newRowIdx, cellIdx];
  const doc3 = updateAt(doc2, cellPath, (c) => node('tableCell', c.attrs || null, [
    node('paragraph', null, [node('formula', { src })]),
  ]));
  return st(doc3, textSelection(pos([...cellPath, 0], 0)));
}

/** Insert a block node immediately after the table containing the selection. */
export function insertAfterTable(state: EditorState, blockNode: DocNode) {
  const ctx = ctxFromState(state);
  if (!ctx || !blockNode) return state;
  const pPath = parentPath(ctx.tablePath);
  const idx = ctx.tablePath[ctx.tablePath.length - 1];
  const doc2 = updateAt(state.doc, pPath, (par) => {
    const content: DocNode[] = par.content.slice();
    content.splice(idx + 1, 0, blockNode);
    return { ...par, content };
  });
  return st(doc2, nodeSelection([...pPath, idx + 1]));
}

/** Toggle whether the first row of the current table is a header row. */
export function toggleHeaderRow(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const currentlyHeader = !!table.content[0]?.content?.[0]?.attrs?.header;
  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({
    ...t,
    content: t.content.map((row, r) => (r === 0
      ? { ...row, content: row.content.map((cell) => node('tableCell', { ...(cell.attrs || {}), header: !currentlyHeader }, cell.content)) }
      : row)),
  }));
  return st(doc2, state.selection);
}

export function deleteRow(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  if (table.content.length <= 1) return deleteTable(state);
  const { grid } = tableGrid(table);
  const Y = ctx.rowIdx;

  // Cells reaching INTO the row from above shrink by one; cells that start in
  // it and continue below move down to the next row with rowspan-1. Neither
  // used to happen, so a rowspan was left overflowing the table body.
  const shrink = new Set();
  const moved: { cell: UpdatedNode; col: number }[] = [];
  for (const e of distinctEntries(grid[Y] || [])) {
    const { rs } = spanOf(e.cell);
    if (e.originR < Y) { if (rs > 1) shrink.add(`${e.rowIdx}:${e.cellIdx}`); continue; }
    if (rs > 1) moved.push({ cell: withSpan(e.cell, 'rowspan', rs - 1), col: e.originC });
  }
  moved.sort((a, b) => a.col - b.col);

  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => {
    const content = t.content.map((row, r) => ({
      ...row,
      content: row.content.map((cell, i) => (shrink.has(`${r}:${i}`) ? withSpan(cell, 'rowspan', spanOf(cell).rs - 1) : cell)),
    }));
    // Re-home the moved cells into the row below (if there is one).
    if (moved.length && Y + 1 < content.length) {
      const target = content[Y + 1];
      const cells = target.content.slice();
      for (const m of moved) {
        let idx = 0;
        for (let i = 0; i < cells.length; i++) {
          const c = ownColOf(grid, Y + 1, i);
          if (c != null && c < m.col) idx = i + 1;
        }
        cells.splice(idx, 0, m.cell);
      }
      content[Y + 1] = { ...target, content: cells };
    }
    content.splice(Y, 1);
    return { ...t, content };
  });
  // Refs to the deleted row become #REF!; refs below it shift up one (S6).
  const doc3 = updateAt(doc2, ctx.tablePath, (t) => remapFormulasInTable(t, {
    rowMap: (r) => (r === Y ? null : r > Y ? r - 1 : r),
  }));
  const row = Math.min(Y, getNode(doc3, ctx.tablePath).content.length - 1);
  return st(doc3, textSelection(pos([...ctx.tablePath, row, 0, 0], 0)));
}

export function inTable(state: EditorState) {
  return !!ctxFromState(state);
}

/* ── A1 references (for the formula editor's click-to-pick) ── */

/** Visual { r, c, tablePath } of a cell path, or null. */
export function cellCoordsVisual(doc: DocNode, cellPath: number[]) {
  const ctx = tableContext(doc, cellPath);
  if (!ctx) return null;
  const { grid } = tableGrid(getNode(doc, ctx.tablePath));
  const e = entryFor(grid, ctx.rowIdx, ctx.cellIdx);
  return e ? { r: e.originR, c: e.originC, tablePath: ctx.tablePath } : null;
}

/** "A1" for a cell path — row 1 is the table's first row, as in a spreadsheet. */
export function cellRef(doc: DocNode, cellPath: number[]) {
  const co = cellCoordsVisual(doc, cellPath);
  return co ? `${colLabel(co.c)}${co.r + 1}` : null;
}

/** "A1" / "A1:C4" for a pair of visual coordinates (order-independent). */
export function rangeRef(a: { r: number; c: number; tablePath?: number[] }, b: { r: number; c: number; tablePath?: number[] }) {
  if (!a || !b) return null;
  const r1 = Math.min(a.r, b.r); const r2 = Math.max(a.r, b.r);
  const c1 = Math.min(a.c, b.c); const c2 = Math.max(a.c, b.c);
  const from = `${colLabel(c1)}${r1 + 1}`;
  const to = `${colLabel(c2)}${r2 + 1}`;
  return from === to ? from : `${from}:${to}`;
}

/** Whole-column range, e.g. "B:B" (or "B:D" across a span of columns). */
export function columnRef(c1: number, c2: number = c1) {
  const lo = Math.min(c1, c2); const hi = Math.max(c1, c2);
  return `${colLabel(lo)}:${colLabel(hi)}`;
}

/* ── index-addressed structural ops (row/column gutter buttons) ── */

/** Delete row `rowIdx` of the table at `tablePath`. */
export function deleteRowAt(state: EditorState, tablePath: number[], rowIdx: number) {
  const table = getNode(state.doc, tablePath);
  if (!table?.content?.[rowIdx]?.content?.length) return state;
  return deleteRow(withCaretAt(state, tablePath, rowIdx, 0));
}

/** Select the whole of visual column `col` as a cell rectangle. */
export function selectColumn(state: EditorState, tablePath: number[], col: number) {
  const { grid, rows } = tableGrid(getNode(state.doc, tablePath));
  const first = grid[0]?.[col];
  const last = grid[rows - 1]?.[col];
  if (!first || !last) return state;
  return st(state.doc, cellSelection(
    [...tablePath, first.rowIdx, first.cellIdx],
    [...tablePath, last.rowIdx, last.cellIdx],
  ));
}

/** Select the whole of row `rowIdx` as a cell rectangle. */
export function selectRow(state: EditorState, tablePath: number[], rowIdx: number) {
  const { grid, cols } = tableGrid(getNode(state.doc, tablePath));
  const first = grid[rowIdx]?.[0];
  const last = grid[rowIdx]?.[cols - 1];
  if (!first || !last) return state;
  return st(state.doc, cellSelection(
    [...tablePath, first.rowIdx, first.cellIdx],
    [...tablePath, last.rowIdx, last.cellIdx],
  ));
}

/* ── cell-rectangle selection helpers ───────────────────── */

/**
 * When `sel` is a cell selection covering exactly one FULL visual column,
 * return { tablePath, col }; else null. Drives the toolbar's Insert-formula
 * routing: a full-column selection means "total this column", not "overwrite
 * the anchor cell".
 */
export function fullColumnSelection(doc: DocNode, sel: Selection) {
  if (!doc || !sel) return null;
  const rect = cellRect(doc, sel);
  if (!rect || rect.minC !== rect.maxC) return null;
  const { rows } = tableGrid(getNode(doc, rect.tablePath));
  if (rect.minR !== 0 || rect.maxR !== rows - 1) return null;
  return { tablePath: rect.tablePath, col: rect.minC };
}

/** Clear the text content of every cell in the current cell selection. */
export function clearCells(state: EditorState) {
  const rect = cellRect(state.doc, state.selection);
  if (!rect) return state;
  let doc2 = state.doc;
  for (const cellPath of rect.cells) {
    // Guard the node: updateAt recurses into a missing index and hands the
    // callback `undefined`, so spreading it produced a node with no `type`
    // that then rendered a <div> inside a <tr>.
    if (!getNode(doc2, cellPath)) continue;
    doc2 = updateAt(doc2, cellPath, (cell) => (cell ? { ...cell, content: [emptyParagraph()] } : cell));
  }
  return st(doc2, state.selection);
}

/** Set text alignment on the current cell (text selection) or all selected cells. */
export function setCellAlign(state: EditorState, align: string) {
  const sel = state.selection;
  let cellPaths: number[][] = [];
  if (isCell(sel)) {
    const rect = cellRect(state.doc, sel);
    cellPaths = rect ? rect.cells : [];
  } else {
    const ctx = ctxFromState(state);
    if (ctx) cellPaths = [[...ctx.tablePath, ctx.rowIdx, ctx.cellIdx]];
  }
  if (!cellPaths.length) return state;
  let doc2 = state.doc;
  for (const p of cellPaths) {
    doc2 = updateAt(doc2, p, (cell) => node('tableCell', { ...(cell.attrs || {}), align: align === 'left' ? null : align }, cell.content));
  }
  return st(doc2, sel);
}

/** Set a column's width (px) on every cell in that column (per-cell, table-layout:fixed). */
export function setColumnWidth(state: EditorState, colIdx: number, width: number) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const w = width ? Math.max(40, Math.round(width)) : null;
  const table = getNode(state.doc, ctx.tablePath);
  const { grid, rows } = tableGrid(table);
  // colIdx is a VISUAL column. Only cells that are exactly one column wide and
  // start here carry the width — a merged cell spans several columns, so its
  // width isn't this column's width. Comparing array index to column index put
  // the width on the wrong cells in any merged table.
  const targets = new Set();
  for (let r = 0; r < rows; r++) {
    const e = grid[r]?.[colIdx];
    if (e && e.originC === colIdx && spanOf(e.cell).cs === 1) targets.add(`${e.rowIdx}:${e.cellIdx}`);
  }
  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({
    ...t,
    content: t.content.map((row, r) => ({
      ...row,
      content: row.content.map((cell, i) => (targets.has(`${r}:${i}`)
        ? node('tableCell', { ...(cell.attrs || {}), colwidth: w }, cell.content)
        : cell)),
    })),
  }));
  return st(doc2, state.selection);
}

/** Plain-text (pipe-delimited) serialization of a table — used for clipboard. */
export function tableToText(table: DocNode) {
  const rows = (table.content || []).map((row) => (row.content || []).map(cellText).join('\t'));
  return rows.join('\n');
}

/** Plain text of the cells in a rectangle (rows joined by newlines, cols by tabs). */
export function cellRectToText(doc: DocNode, rect: { tablePath: number[]; minR: number; maxR: number; minC: number; maxC: number; grid?: Grid }) {
  const grid = rect.grid || tableGrid(getNode(doc, rect.tablePath)).grid;
  const lines = [];
  for (let r = rect.minR; r <= rect.maxR; r++) {
    const cols = [];
    const emitted = new Set();
    for (let c = rect.minC; c <= rect.maxC; c++) {
      const e = grid[r]?.[c];
      if (!e) { cols.push(''); continue; }
      const key = `${e.rowIdx}:${e.cellIdx}`;
      // A merged cell's text belongs to its first column only; the rest of the
      // slots it covers are blank, so columns still line up.
      cols.push(emitted.has(key) ? '' : cellText(e.cell));
      emitted.add(key);
    }
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}

