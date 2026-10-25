import { getNode, updateAt, parentPath, type UpdatedNode } from './doc';
import { node, emptyParagraph } from '../model/nodes.js';
import { textSelection, pos, isText, isNode, isCell, type TextSelection, type NodeSelection } from './selection.js';
import { inlineToTokens } from './inline.js';
import { isTextblock, type DocNode } from '../model/schema.js';
import { remapFormulasInTable } from './formulaRemap.js';
import type { CellSelection, Selection } from './selection';
import type { EditorState } from './state.js';
import type { GridEntry, Grid } from './tables.types';

export const st = (doc: DocNode, selection: TextSelection | NodeSelection | CellSelection) => ({ doc, selection, storedMarks: null });

export const spanOf = (cell: DocNode | undefined) => ({
  cs: Math.max(1, parseInt(String(cell?.attrs?.colspan), 10) || 1),
  rs: Math.max(1, parseInt(String(cell?.attrs?.rowspan), 10) || 1),
});

/**
 * Expand a table into its visual grid.
 *
 * `grid[r][c]` is `{ cell, rowIdx, cellIdx, originR, originC }` — the cell that
 * OCCUPIES that visual slot. A merged cell repeats the same entry across every
 * slot it covers, so a visual column can always be mapped back to the array
 * index that actually holds it. `cols` is the widest visual row.
 */
export function tableGrid(table: DocNode|null|undefined) {
  const rows = table?.content || [];
  const grid: Grid = rows.map(() => []);
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].content || [];
    let c = 0;
    for (let i = 0; i < cells.length; i++) {
      while (grid[r][c]) c += 1;              // slot taken by a span from above
      const { cs, rs } = spanOf(cells[i]);
      const entry = { cell: cells[i], rowIdx: r, cellIdx: i, originR: r, originC: c };
      for (let dr = 0; dr < rs; dr++) {
        const rr = r + dr;
        if (rr >= rows.length) break;         // span overflowing the table body
        for (let dc = 0; dc < cs; dc++) if (!grid[rr][c + dc]) grid[rr][c + dc] = entry;
      }
      c += cs;
    }
  }
  const cols = grid.reduce((m, row) => Math.max(m, row.length), 0);
  return { grid, rows: rows.length, cols };
}

/** The grid entry for an (rowIdx, cellIdx) array position. */
export function entryFor(grid: Grid, rowIdx: number, cellIdx: number) {
  const row = grid[rowIdx] || [];
  for (const e of row) if (e && e.rowIdx === rowIdx && e.cellIdx === cellIdx) return e;
  return null;
}

/** Visual column where row `r`'s own cell `i` starts, or null. */
export function ownColOf(grid: Grid, r: number, i: number) {
  const e = entryFor(grid, r, i);
  return e ? e.originC : null;
}

/** Distinct cells occupying visual column range, deduped by origin. */
export function distinctEntries(entries: (GridEntry | undefined)[]) {
  const seen = new Set<string>();
  const out: GridEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    const key = `${e.rowIdx}:${e.cellIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export const withSpan = (cell: DocNode, key: string, value: number): UpdatedNode => {
  const attrs = { ...(cell.attrs || {}) };
  if (value > 1) attrs[key] = value; else delete attrs[key];
  return { ...cell, attrs: Object.keys(attrs).length ? attrs : null };
};

export function makeCell(header: boolean) {
  return node('tableCell', header ? { header: true } : null, [emptyParagraph()]);
}

/** Find { tablePath, rowIdx, cellIdx } for a selection path inside a table. */
export function tableContext(doc: DocNode, path: number[]) {
  for (let i = 0; i < path.length; i++) {
    const p = path.slice(0, i + 1);
    if (getNode(doc, p).type === 'table') {
      // A table- or row-level path has no cell address. Defaulting to (0,0)
      // here made table-level commands silently target header cell A1 (S4).
      if (path[i + 1] === undefined || path[i + 2] === undefined) return null;
      return { tablePath: p, rowIdx: path[i + 1], cellIdx: path[i + 2] };
    }
  }
  return null;
}

export function ctxFromState(state: EditorState) {
  const sel = state.selection;
  const path = isText(sel) ? sel.anchor.path : isNode(sel) ? sel.path : isCell(sel) ? sel.anchorCell : null;
  if (!path) return null;
  return tableContext(state.doc, path);
}

export function addRowAfter(state: EditorState) { return addRow(state, 1); }

export function addRow(state: EditorState, after: number) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const { grid, cols } = tableGrid(table);
  const at = ctx.rowIdx + after;

  // A cell spanning ACROSS the insertion boundary grows by one row instead of
  // the new row getting a cell in that column.
  const covered = new Set();
  if (at > 0 && at < table.content.length) {
    for (const e of distinctEntries(grid[at] || [])) {
      if (e.originR < at) {
        covered.add(`${e.rowIdx}:${e.cellIdx}`);
        for (let c = e.originC; c < e.originC + spanOf(e.cell).cs; c++) covered.add(`col:${c}`);
      }
    }
  }
  const newCells = [];
  for (let c = 0; c < Math.max(1, cols); c++) if (!covered.has(`col:${c}`)) newCells.push(makeCell(false));
  const newRow = node('tableRow', null, newCells.length ? newCells : [makeCell(false)]);

  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => {
    const content = t.content.map((row, r) => ({
      ...row,
      content: row.content.map((cell, i) => (covered.has(`${r}:${i}`)
        ? withSpan(cell, 'rowspan', spanOf(cell).rs + 1)
        : cell)),
    }));
    content.splice(at, 0, newRow);
    return { ...t, content };
  });
  // References at/below the insertion point shift down one row (S6).
  const doc3 = updateAt(doc2, ctx.tablePath, (t) => remapFormulasInTable(t, {
    rowMap: (r) => (r >= at ? r + 1 : r),
  }));
  return st(doc3, textSelection(pos([...ctx.tablePath, at, 0, 0], 0)));
}

export function addColumn(state: EditorState, after: number) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const { grid, rows } = tableGrid(table);
  const anchor = entryFor(grid, ctx.rowIdx, ctx.cellIdx);
  // Insertion boundary in VISUAL columns: array indices are meaningless once a
  // row above holds a colspan.
  const X = anchor ? anchor.originC + (after ? spanOf(anchor.cell).cs : 0) : ctx.cellIdx + after;

  const widen = new Set();          // `rowIdx:cellIdx` of cells straddling X
  const insertAt = new Map();       // rowIdx → array index for the new cell
  for (let r = 0; r < rows; r++) {
    const e = grid[r]?.[X];
    if (e && e.originC < X) { widen.add(`${e.rowIdx}:${e.cellIdx}`); continue; }
    insertAt.set(r, e ? e.cellIdx : (table.content[r]?.content?.length || 0));
  }

  const headerRow0 = !!table.content[0]?.content?.[0]?.attrs?.header;
  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({
    ...t,
    content: t.content.map((row, r) => {
      const cells = row.content.map((cell, i) => (widen.has(`${r}:${i}`)
        ? withSpan(cell, 'colspan', spanOf(cell).cs + 1)
        : cell));
      if (insertAt.has(r)) cells.splice(insertAt.get(r), 0, makeCell(r === 0 && headerRow0));
      return { ...row, content: cells };
    }),
  }));
  // References at/right of the insertion boundary shift one column (S6).
  const doc3 = updateAt(doc2, ctx.tablePath, (t) => remapFormulasInTable(t, {
    colMap: (c) => (c >= X ? c + 1 : c),
  }));
  const caretIdx = insertAt.has(ctx.rowIdx) ? insertAt.get(ctx.rowIdx) : ctx.cellIdx;
  return st(doc3, textSelection(pos([...ctx.tablePath, ctx.rowIdx, caretIdx, 0], 0)));
}

/** A cell that may be replaced by a formula: empty / whitespace-only text, or
 *  already holding just a formula atom (+ whitespace strays). Anything else —
 *  real text, other atoms, nested blocks — refuses, so Insert formula can
 *  never destroy data (S4). Duplicates the small formula.js walk to avoid a
 *  tables↔formula import cycle. */
function cellReplaceableByFormula(cell: DocNode | undefined) {
  let formulas = 0;
  for (const b of cell?.content || []) {
    for (const inl of b?.content || []) {
      if (inl?.type === 'formula') { formulas += 1; if (formulas > 1) return false; continue; }
      if (inl?.type === 'text') { if ((inl.text || '').trim() !== '') return false; continue; }
      return false;
    }
  }
  return true;
}

/** Replace the current cell's content with a single formula atom (=…).
 *  Refuses (returns state unchanged) when the selection spans more than one
 *  cell or the target cell holds anything besides whitespace or an existing
 *  formula — the old version wiped whatever the cell contained (S4). */
export function setCellFormula(state: EditorState, src: string) {
  const sel = state.selection;
  if (isCell(sel)) {
    const rect = cellRect(state.doc, sel);
    if (!rect || rect.cells.length !== 1) return state;
  }
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const cellPath = [...ctx.tablePath, ctx.rowIdx, ctx.cellIdx];
  const cell = getNode(state.doc, cellPath);
  if (!cell || cell.type !== 'tableCell' || !cellReplaceableByFormula(cell)) return state;
  const doc2 = updateAt(state.doc, cellPath, (c) => node('tableCell', c.attrs || null, [
    node('paragraph', null, [node('formula', { src: src || '=' })]),
  ]));
  return st(doc2, textSelection(pos([...cellPath, 0], 0)));
}

export function deleteColumn(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const { grid } = tableGrid(getNode(state.doc, ctx.tablePath));
  const anchor = entryFor(grid, ctx.rowIdx, ctx.cellIdx);
  return deleteColumnAt(state, ctx.tablePath, anchor ? anchor.originC : ctx.cellIdx, ctx);
}

/**
 * Delete VISUAL column `X`.
 *
 * Addressed by visual column, not by a cell: routing this through the selection
 * meant that clicking the gutter for a column covered by a span deleted the
 * span's ORIGIN column instead of the one the user pointed at.
 */
export function deleteColumnAt(state: EditorState, tablePath: number[], X: number, ctxIn: { tablePath: number[]; rowIdx: number; cellIdx: number } | null = null) {
  const table = getNode(state.doc, tablePath);
  if (!table) return state;
  const { grid, rows, cols } = tableGrid(table);
  if (cols <= 1) return deleteTable(ctxIn ? state : { ...state, selection: textSelection(pos([...tablePath, 0, 0, 0], 0)) });
  const ctx = ctxIn || { tablePath, rowIdx: 0, cellIdx: 0 };

  // A cell wider than one column shrinks; a plain cell is removed. Working from
  // array indices meant a short row (a merged header) simply had nothing at
  // that index, so the column could never be deleted from it.
  const shrink = new Set();
  const remove = new Set();
  const seen = new Set();
  for (let r = 0; r < rows; r++) {
    const e = grid[r]?.[X];
    if (!e) continue;
    const key = `${e.rowIdx}:${e.cellIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (spanOf(e.cell).cs > 1) shrink.add(key); else remove.add(key);
  }

  const doc2 = updateAt(state.doc, ctx.tablePath, (t) => ({
    ...t,
    content: t.content.map((row, r) => {
      const cells = row.content
        .map((cell, i) => (shrink.has(`${r}:${i}`) ? withSpan(cell, 'colspan', spanOf(cell).cs - 1) : cell))
        .filter((_, i) => !remove.has(`${r}:${i}`));
      // A row whose every cell sat in the deleted column keeps ONE empty cell —
      // dropping it meant a column delete could delete rows (S6, old :352).
      return { ...row, content: cells.length ? cells : [makeCell(false)] };
    }),
  }));
  // Refs to the deleted column become #REF!; refs right of it shift left (S6).
  const doc3 = updateAt(doc2, ctx.tablePath, (t) => remapFormulasInTable(t, {
    colMap: (c) => (c === X ? null : c > X ? c - 1 : c),
  }));
  const target = getNode(doc3, ctx.tablePath);
  const row = Math.min(ctx.rowIdx, (target?.content?.length || 1) - 1);
  const col = Math.max(0, Math.min(ctx.cellIdx, (target?.content?.[row]?.content?.length || 1) - 1));
  return st(doc3, textSelection(pos([...ctx.tablePath, row, col, 0], 0)));
}

export function deleteTable(state: EditorState) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const pPath = parentPath(ctx.tablePath);
  const idx = ctx.tablePath[ctx.tablePath.length - 1];
  const doc2 = updateAt(state.doc, pPath, (par) => {
    const content: DocNode[] = par.content.slice();
    content.splice(idx, 1, emptyParagraph());
    return { ...par, content };
  });
  return st(doc2, textSelection(pos([...pPath, idx], 0)));
}

/** Move the caret to the next/prev cell, creating a row when tabbing past the end. */
export function goToCell(state: EditorState, dir: number) {
  const ctx = ctxFromState(state);
  if (!ctx) return state;
  const table = getNode(state.doc, ctx.tablePath);
  const { grid, rows, cols } = tableGrid(table);
  if (!cols) return state;
  const anchor = entryFor(grid, ctx.rowIdx, ctx.cellIdx);
  const r0 = anchor ? anchor.originR : ctx.rowIdx;
  const c0 = anchor ? anchor.originC : ctx.cellIdx;
  // Step past the whole width of a merged cell, and use the VISUAL column count.
  // Taking row 0's array length as the width meant a merged header made the
  // last column unreachable and every second Tab appended a new row.
  let r = r0;
  let c = dir > 0 ? c0 + spanOf(anchor?.cell).cs : c0 - 1;
  if (c >= cols) { c = 0; r += 1; }
  if (c < 0) { c = cols - 1; r -= 1; }
  if (r >= rows) return addRowAfter(state);
  if (r < 0) return state;
  // Skip slots covered by a span reaching in from elsewhere.
  let guard = cols * rows;
  while (guard-- > 0) {
    const e = grid[r]?.[c];
    if (e && !(e.originR === r0 && e.originC === c0)) {
      return st(state.doc, textSelection(pos([...ctx.tablePath, e.rowIdx, e.cellIdx, 0], 0)));
    }
    c += dir > 0 ? 1 : -1;
    if (c >= cols) { c = 0; r += 1; }
    if (c < 0) { c = cols - 1; r -= 1; }
    if (r >= rows) return addRowAfter(state);
    if (r < 0) return state;
  }
  return state;
}

/** Put the caret in a specific cell so a selection-driven command targets it. */
export function withCaretAt(state: EditorState, tablePath: number[], rowIdx: number, cellIdx: number) {
  return { ...state, selection: textSelection(pos([...tablePath, rowIdx, cellIdx, 0], 0)) };
}

/** The rectangle spanned by a cell selection: { tablePath, minR, maxR, minC, maxC, cells:[cellPath] }. */
export function cellRect(doc: DocNode, sel: Selection) {
  if (!isCell(sel)) return null;
  const a = cellCoords(doc, sel.anchorCell);
  const b = cellCoords(doc, sel.headCell);
  if (!a || !b || a.tablePath.join() !== b.tablePath.join()) return null;
  const table = getNode(doc, a.tablePath);
  const { grid, rows, cols } = tableGrid(table);
  const ea = entryFor(grid, a.r, a.c);
  const eb = entryFor(grid, b.r, b.c);
  // Work in visual coordinates, and expand the rectangle so a merged cell is
  // never half-selected.
  const av = ea ? { r: ea.originR, c: ea.originC, cs: spanOf(ea.cell).cs, rs: spanOf(ea.cell).rs } : { r: a.r, c: a.c, cs: 1, rs: 1 };
  const bv = eb ? { r: eb.originR, c: eb.originC, cs: spanOf(eb.cell).cs, rs: spanOf(eb.cell).rs } : { r: b.r, c: b.c, cs: 1, rs: 1 };
  const minR = Math.max(0, Math.min(av.r, bv.r));
  const maxR = Math.min(rows - 1, Math.max(av.r + av.rs - 1, bv.r + bv.rs - 1));
  const minC = Math.max(0, Math.min(av.c, bv.c));
  const maxC = Math.min(Math.max(0, cols - 1), Math.max(av.c + av.cs - 1, bv.c + bv.cs - 1));

  // Resolve visual slots to real cell paths, deduped — the old version emitted
  // one path per visual slot, so a ragged or merged rectangle produced paths
  // that address nothing and updateAt built a type-less node from `undefined`.
  const seen = new Set();
  const cells = [];
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const e = grid[r]?.[c];
      if (!e) continue;
      const key = `${e.rowIdx}:${e.cellIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push([...a.tablePath, e.rowIdx, e.cellIdx]);
    }
  }
  return { tablePath: a.tablePath, minR, maxR, minC, maxC, cells, grid };
}

function cellCoords(doc: DocNode, cellPath: number[]) {
  const ctx = tableContext(doc, cellPath);
  if (!ctx) return null;
  return { tablePath: ctx.tablePath, r: ctx.rowIdx, c: ctx.cellIdx };
}

export function cellText(cell: DocNode) {
  const parts: string[] = [];
  const walk = (n: DocNode) => {
    if (!n) return;
    if (isTextblock(n.type)) { parts.push(inlineToTokens(n.content).filter((t) => !t.node).map((t) => t.ch).join('')); return; }
    (n.content || []).forEach(walk);
  };
  walk(cell);
  return parts.join(' ');
}
