import type { Row, Table } from '@tanstack/react-table';
import type { TABLE_FEATURES } from './gridConstants';

/** Shared types of the App Studio data grid modules. */

export type GridRecord = Record<string, any>;
export type GridFeatures = typeof TABLE_FEATURES;
export type GridTable = Table<GridFeatures, GridRecord>;
export type GridRow = Row<GridFeatures, GridRecord>;
export type RunAction = (actionId: string, payload: Record<string, unknown>) => unknown;

/** What useGridColumns puts in each column's `meta`. */
export interface GridColumnMeta {
    format?: string;
    editable?: boolean;
    align?: 'left' | 'right' | 'center';
    truncate?: boolean;
    filterKind?: string | null;
    filterOptions?: unknown[] | null;
    toneMap?: unknown[] | null;
    help?: string | null;
    actionId?: string | null;
}

/** A row action, bulk action or toolbar action as the spec stores it. */
export interface GridAction {
    label?: string;
    actionId?: string;
    tone?: string;
}
