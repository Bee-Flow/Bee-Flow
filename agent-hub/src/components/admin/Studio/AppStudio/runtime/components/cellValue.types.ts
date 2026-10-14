/**
 * The shapes a table cell reads: the column configuration, the row, and the
 * props of the cell component. Kept apart from the rendering modules so the
 * tone, pill and format code can share them without importing each other.
 */

/** One value → tone (and label) entry of a column's toneMap. */
export interface ToneEntry {
    value?: unknown;
    tone?: string;
    label?: unknown;
}
/**
 * The column configuration a cell reads. Only the keys the cell switch uses are
 * named; a table's own column definition carries more and passes through.
 */
export interface CellColumn {
    key?: string;
    format?: string;
    align?: string;
    toneMap?: ToneEntry[];
    toneFrom?: string;
    emptyTone?: string;
    badgeStyle?: string;
    flagFrom?: string;
    flagTone?: string;
    subtextFrom?: string;
    subtextToneFrom?: string;
    labelFrom?: string;
    truncate?: boolean;
    tone?: string;
    max?: number;
    [key: string]: unknown;
}
/** A row as the table hands it to a cell. */
export type CellRow = Record<string, unknown>;
export interface CellValueProps {
    value: unknown;
    format?: string;
    col?: CellColumn | null;
    row?: CellRow | null;
    now?: number | null;
}
