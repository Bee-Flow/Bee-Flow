import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { mkTt } from './toolbarPrimitives.jsx';
import type { TranslateFn } from '../../hooks/useTranslation';
import { colLabel } from '../engine/formulaRefs.js';
import { tableGrid as tableGridJs } from '../engine/tables.helpers';
import * as Tbl from '../engine/tables';

/** A table/row/cell/text node of the document model. */
interface DocNode { type: string; text?: string; attrs?: Record<string, any>; content?: DocNode[] }

/** One slot of the visual grid: the cell covering it and where that cell starts. */
interface GridEntry { cell: DocNode; rowIdx: number; cellIdx: number; originR: number; originC: number }

type Grid = (GridEntry | undefined)[][];

const tableGrid = tableGridJs as unknown as (table: DocNode) => { grid: Grid; rows: number; cols: number };

interface ColBox { left: number; width: number }
interface RowBox { top: number; height: number }
interface Geometry { colX: (ColBox | null)[]; rowY: RowBox[]; cols: number; rows: number; grid: Grid }
interface TableRect { top: number; left: number; right: number; bottom: number; width: number; height: number }

/** The table the caret sits in, as the view's `tableInfo()` reports it. */
export interface TableInfo { el: HTMLElement | null; node: DocNode; path: number[]; ordinal: number }

interface Props {
  view: any;
  info: TableInfo;
  t: TranslateFn;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  headersHidden: boolean;
}

/* ── table add-row / add-column controls ─────────────────── */
// Floating "+" affordances glued to the right edge (add column) and bottom edge
// (add row) of the table the caret is in. Re-measures on scroll/resize and when
// the table node changes (after an append). Appends always go to the table end.
/**
 * Per-visual-column and per-row screen geometry for a rendered table.
 *
 * Derived from the DOM rather than assumed, because colspan/rowspan mean a
 * row's array index is not its column number. For each visual column we look
 * for a cell that starts there and is exactly one column wide; if the whole
 * column is spanned we fall back to slicing a spanning cell evenly.
 */
function tableGeometry(tableEl: HTMLElement | null, node: DocNode | null): Geometry | null {
  if (!tableEl || !node) return null;
  const { grid, rows, cols } = tableGrid(node);
  // :scope keeps rows of a nested table (legacy artifact) out of the outer
  // table's geometry — unscoped, every nested row inflated rowY and misplaced
  // the row gutter and overlays (S8).
  const rowEls = Array.from(tableEl.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr'));
  if (!rowEls.length || !cols) return null;

  const colX: (ColBox | null)[] = new Array(cols).fill(null);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const e = grid[r]?.[c];
      if (!e) continue;
      const el = rowEls[e.rowIdx]?.children?.[e.cellIdx];
      if (!el) continue;
      const box = el.getBoundingClientRect();
      const span = Math.max(1, parseInt(e.cell?.attrs?.colspan, 10) || 1);
      if (span === 1 && e.originC === c) { colX[c] = { left: box.left, width: box.width }; break; }
      // Spanned: take this column's share of the spanning cell.
      if (!colX[c]) colX[c] = { left: box.left + ((c - e.originC) * box.width) / span, width: box.width / span };
    }
  }
  const rowY = rowEls.map((el) => { const b = el.getBoundingClientRect(); return { top: b.top, height: b.height }; });
  return { colX, rowY, cols, rows, grid };
}

/** Column label: ALWAYS the spreadsheet letter — `A · headertext` when the
 *  table has a header row — so a formula's `A1` has a visible anchor even on
 *  tables with named headers. */
function columnName(node: DocNode, grid: Grid, c: number): string {
  const letter = colLabel(c);
  const head = grid[0]?.[c];
  if (head?.cell?.attrs?.header) {
    const text: string[] = [];
    const walk = (n: DocNode | undefined): void => { if (!n) return; if (n.type === 'text') text.push(n.text || ''); (n.content || []).forEach(walk); };
    walk(head.cell);
    const s = text.join('').trim();
    if (s) return `${letter} · ${s}`;
  }
  return letter;
}

// Exported for TableControls.test.jsx: the crash in BFSF-351 lived in the two
// gutter .map()s below, and reaching them from a full BeeEditor mount would mean
// driving a real caret into a real table.
export function TableControls({ view, info, t, collapsed, onToggleCollapse, headersHidden }: Props) {
  const tt = mkTt(t);
  const [rect, setRect] = useState<TableRect | null>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);
  // Top of the editable area — the column strip sits above the table and must
  // not be drawn over the toolbar when a table is the very first block.
  const [hostTop, setHostTop] = useState<number | null>(null);
  useEffect(() => {
    if (!view || !info?.el) { setRect(null); setGeom(null); return undefined; }
    const measure = () => {
      const r = info.el!.getBoundingClientRect();
      if (!r.width && !r.height) { setRect(null); setGeom(null); return; }
      setRect({ top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      setGeom(collapsed ? null : tableGeometry(info.el, info.node));
      try { setHostTop(view.host.getBoundingClientRect().top); } catch (e) { setHostTop(null); }
    };
    measure();
    const scroller = view.host?.closest('.overflow-y-auto') || window;
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { scroller.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [view, info?.el, info?.node, collapsed, headersHidden]);
  if (!rect) return null;
  const run = (cmd: string) => view.chain().focus()[cmd]().run();
  const dispatch = (fn: (s: any) => any, kind = 'structural') => view.dispatch(fn, { kind });
  const btn = 'fixed z-[60] flex items-center justify-center rounded-md border shadow-sm transition-colors hover:text-white hover:bg-[var(--accent-primary)] hover:border-[var(--accent-primary)]';
  const style = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' };
  const rows = info.node?.content?.length || 0;
  return (
    <>
      {/* collapse / expand chevron in the left gutter */}
      <button type="button" title={collapsed ? tt('notebooks.expand_table', 'Expand table') : tt('notebooks.collapse_table', 'Collapse table')}
        onMouseDown={(e) => { e.preventDefault(); onToggleCollapse?.(); }}
        className={btn} style={{ ...style, top: rect.top + 2, left: rect.left - 26, width: 22, height: 22 }}>
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {collapsed ? (
        <span className="fixed z-[60] px-2 py-0.5 rounded-md border shadow-sm text-[10px] font-medium"
          style={{ ...style, top: rect.top + 2, left: rect.right + 6 }}>
          {tt('notebooks.rows_collapsed', '{n} rows').replace('{n}', String(rows))}
        </span>
      ) : (
        <>
          <button type="button" title={tt('notebooks.add_column', 'Add column')} aria-label={tt('notebooks.add_column', 'Add column')}
            onMouseDown={(e) => { e.preventDefault(); run('appendColumn'); }}
            className={btn} style={{ ...style, top: rect.top + rect.height / 2 - 11, left: rect.right + 4, width: 22, height: 22 }}>
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button type="button" title={tt('notebooks.add_row', 'Add row')} aria-label={tt('notebooks.add_row', 'Add row')}
            onMouseDown={(e) => { e.preventDefault(); run('appendRow'); }}
            className={btn} style={{ ...style, top: rect.bottom + 4, left: rect.left + rect.width / 2 - 11, width: 22, height: 22 }}>
            <Plus className="w-3.5 h-3.5" />
          </button>

          {/* ── Column-name strip ──
              Shows the header cell's text when the table has one, otherwise the
              spreadsheet letter, so a formula's A1 always has a visible anchor.
              Click selects the column; the × deletes it; while a formula editor
              is open a click inserts a whole-column reference instead. */}
          {!headersHidden && geom && hostTop != null && rect.top - 20 >= hostTop && geom.colX.map((col, c) => col && (
            <div key={`c${c}`} className="bf-table-colhead group/col"
              style={{ position: 'fixed', zIndex: 59, top: rect.top - 20, left: col.left, width: col.width, height: 18 }}
              onMouseDown={(e) => {
                e.preventDefault();
                if (view.refPick) {
                  const tp = view.refPick.tablePath;
                  if (!tp || tp.join() === info.path.join()) { view.refPick.onPick?.(Tbl.columnRef(c)); view.refPick.onCommitPick?.(); }
                  return;
                }
                dispatch((s) => Tbl.selectColumn(s, info.path, c), 'selection');
              }}
              title={tt('notebooks.select_column', 'Select column')}
            >
              <span className="bf-table-colhead-label">{columnName(info.node, geom.grid, c)}</span>
              <button type="button" className="bf-table-gutter-sum opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.sum_column', 'Sum column')} aria-label={tt('notebooks.sum_column', 'Sum column')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.addColumnTotal(s, info.path, c)); }}>
                Σ
              </button>
              <button type="button" className="bf-table-gutter-del opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.delete_col', 'Delete column')} aria-label={tt('notebooks.delete_col', 'Delete column')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.deleteColumnAt(s, info.path, c)); }}>
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}

          {/* ── Row gutter ── click selects the row, × deletes it. */}
          {geom && geom.rowY.map((row, r) => (
            <div key={`r${r}`} className="bf-table-rowhead group/row"
              style={{ position: 'fixed', zIndex: 59, top: row.top, left: rect.left - 22, width: 20, height: row.height }}
              onMouseDown={(e) => { e.preventDefault(); dispatch((s) => Tbl.selectRow(s, info.path, r), 'selection'); }}
              title={tt('notebooks.select_row', 'Select row')}
            >
              <span className="bf-table-rowhead-label">{r + 1}</span>
              <button type="button" className="bf-table-gutter-del opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.delete_row', 'Delete row')} aria-label={tt('notebooks.delete_row', 'Delete row')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.deleteRowAt(s, info.path, r)); }}>
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}
