/**
 * Pure model of the feature-matrix block (issue #529): the shapes the CMS
 * stores, and the helpers the renderer and the editor share. Kept apart from
 * the components so they test without a DOM.
 *
 * Every column, group and row carries a stable `id`, and a row's cells are
 * matched to their column by that id (never by position), so a translation
 * (index-aligned in the locale override, kept on its item through `id` by the
 * server) and the cells survive a reordered column or row.
 */

export interface MatrixColumn {
    id?: string;
    label?: string;
    highlight?: boolean;
}

export interface MatrixCell {
    /** The id of the column this cell belongs to. */
    id?: string;
    kind?: string;
    text?: string;
}

export interface MatrixRow {
    id?: string;
    label?: string;
    cells?: MatrixCell[];
}

export interface MatrixGroup {
    id?: string;
    title?: string;
    rows?: MatrixRow[];
}

/** Bounds of the value columns (server: MATRIX_COLUMNS_MIN / MAX in cmsDefaults.js). */
export const MATRIX_COLUMNS_MAX = 6;

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * A fresh short id, e.g. `col-3f9a1c`. Random, so a deleted item's id is never
 * handed out again. From the CSPRNG (getRandomValues needs no secure context).
 */
export function mintMatrixId(prefix: string): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3));
    return `${prefix}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The column ids in use, in order; a column without an id has none to offer. */
export function columnIds(columns: readonly MatrixColumn[]): string[] {
    return columns.map((c) => c?.id).filter((id): id is string => hasText(id));
}

/** The id of the column a phone shows first: the highlighted one, else the first. */
export function defaultColumnId(columns: readonly MatrixColumn[]): string | undefined {
    const ids = columnIds(columns);
    const highlighted = columns.find((c) => c?.highlight === true && hasText(c.id));
    return highlighted?.id ?? ids[0];
}

/** The cell of `row` that belongs to column `columnId`, or undefined. */
export function cellFor(row: MatrixRow | undefined, columnId: string | undefined): { cell: MatrixCell; index: number } | undefined {
    if (!row || !columnId || !Array.isArray(row.cells)) return undefined;
    const index = row.cells.findIndex((c) => c?.id === columnId);
    return index < 0 ? undefined : { cell: row.cells[index], index };
}

/** What a cell shows: a check, a dash, text, or nothing at all. An unknown kind shows its text. */
export function cellMode(cell: MatrixCell | undefined): 'included' | 'excluded' | 'text' | 'empty' {
    if (!cell) return 'empty';
    if (cell.kind === 'included') return 'included';
    if (cell.kind === 'excluded') return 'excluded';
    return hasText(cell.text) ? 'text' : 'empty';
}

/** True when the row says something: a label or at least one filled cell. */
export function rowHasContent(row: MatrixRow | undefined): boolean {
    if (!row) return false;
    if (hasText(row.label)) return true;
    return (row.cells || []).some((c) => cellMode(c) !== 'empty');
}

/** A group as the renderer walks it: the STORED indices stay attached, so inline-edit paths keep pointing at the stored slot. */
export interface VisibleGroup {
    group: MatrixGroup;
    index: number;
    rows: Array<{ row: MatrixRow; index: number }>;
}

/**
 * The groups to draw. On the published site rows with no content, and groups
 * left without rows, are dropped; the editor (`keepEmpty`) keeps every slot
 * clickable.
 */
export function visibleGroups(groups: readonly MatrixGroup[] | undefined, keepEmpty: boolean): VisibleGroup[] {
    const out: VisibleGroup[] = [];
    (groups || []).forEach((raw, index) => {
        const group = raw || {};
        const rows = (Array.isArray(group.rows) ? group.rows : [])
            .map((row, rowIndex) => ({ row: row || {}, index: rowIndex }))
            .filter(({ row }) => keepEmpty || rowHasContent(row));
        if (keepEmpty || rows.length > 0) out.push({ group, index, rows });
    });
    return out;
}

/** A blank cell for a column: not included, no text. */
export const blankCell = (columnId: string): MatrixCell => ({ id: columnId, kind: 'excluded', text: '' });

/**
 * The groups after the columns changed: every row keeps one cell per column
 * (in column order), a cell of a removed column is dropped, a new column
 * starts as "not included".
 */
export function alignCells(groups: readonly MatrixGroup[], columns: readonly MatrixColumn[]): MatrixGroup[] {
    const ids = columnIds(columns);
    return groups.map((group) => ({
        ...group,
        rows: (group.rows || []).map((row) => ({
            ...row,
            cells: ids.map((id) => cellFor(row, id)?.cell ?? blankCell(id)),
        })),
    }));
}
