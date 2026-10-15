/**
 * selection.js — model selection over (path, offset) positions.
 *
 * A position is { path:number[], offset:number } where path points to a textblock
 * and offset is a token offset within it (see inline.js). Document order equals
 * lexicographic path order then offset, because no textblock path is a prefix of
 * another (textblocks don't contain blocks).
 */
import type { ModelPos } from './textIndex.js';

// Re-exported so the transforms (which have no line to spare) can take them from here.
export type { ModelPos } from './textIndex.js';
export type { EditorState } from './state.js';

export interface TextSelection { type: 'text'; anchor: ModelPos; head: ModelPos }
export interface NodeSelection { type: 'node'; path: number[] }
export interface CellSelection { type: 'cell'; anchorCell: number[]; headCell: number[] }
export type Selection = TextSelection | NodeSelection | CellSelection;
export interface PosRange { from: ModelPos; to: ModelPos }

export function pos(path: number[], offset: number): ModelPos { return { path: path.slice(), offset }; }

export function textSelection(anchor: ModelPos, head?: ModelPos): TextSelection { return { type: 'text', anchor, head: head || anchor }; }
export function nodeSelection(path: number[]): NodeSelection { return { type: 'node', path: path.slice() }; }
/** Rectangular table-cell selection: anchor/head are tableCell paths in one table. */
export function cellSelection(anchorCell: number[], headCell?: number[]): CellSelection { return { type: 'cell', anchorCell: anchorCell.slice(), headCell: (headCell || anchorCell).slice() }; }

export function isText(sel: Selection | null | undefined): sel is TextSelection;
export function isText(sel: Selection | null | undefined): boolean | null | undefined { return sel && sel.type === 'text'; }
export function isNode(sel: Selection | null | undefined): sel is NodeSelection;
export function isNode(sel: Selection | null | undefined): boolean | null | undefined { return sel && sel.type === 'node'; }
export function isCell(sel: Selection | null | undefined): sel is CellSelection;
export function isCell(sel: Selection | null | undefined): boolean | null | undefined { return sel && sel.type === 'cell'; }
export function isCollapsed(sel: Selection | null | undefined): boolean | null | undefined { return isText(sel) && eqPos(sel.anchor, sel.head); }

export function eqPath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function eqPos(a: ModelPos, b: ModelPos): boolean {
  return a.offset === b.offset && eqPath(a.path, b.path);
}

export function cmpPos(a: ModelPos, b: ModelPos): number {
  const n = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < n; i++) {
    if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
  }
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.offset - b.offset;
}

/** Ordered { from, to } for a text selection. */
export function selRange(sel: TextSelection): PosRange;
export function selRange(sel: Selection | null | undefined): PosRange | null;
export function selRange(sel: Selection | null | undefined): PosRange | null {
  if (!isText(sel)) return null;
  return cmpPos(sel.anchor, sel.head) <= 0 ? { from: sel.anchor, to: sel.head } : { from: sel.head, to: sel.anchor };
}

export function eqSelection(a: Selection | null | undefined, b: Selection | null | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  // a.type === b.type was just checked, so b has the variant a has.
  if (a.type === 'node') return eqPath(a.path, (b as NodeSelection).path);
  if (a.type === 'cell') return eqPath(a.anchorCell, (b as CellSelection).anchorCell) && eqPath(a.headCell, (b as CellSelection).headCell);
  return eqPos(a.anchor, (b as TextSelection).anchor) && eqPos(a.head, (b as TextSelection).head);
}
