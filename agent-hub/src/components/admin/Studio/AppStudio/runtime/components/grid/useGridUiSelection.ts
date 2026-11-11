import type { RowSelectionState } from '@tanstack/table-core';
import { usePublishedUiState } from '../../uiState';
import type { GridTable } from './gridTypes';

const NO_ROWS: readonly unknown[] = Object.freeze([]);

/**
 * The selection keys a set_ui value names: a row id, a list of ids, or rows with
 * an id (the grid keys a row by String(id ?? _id), useGridEditQueue.rowKey).
 * null, '' or an empty list clear the selection. A single-select grid keeps the first.
 */
export function selectionFromValue(value: unknown, multi: boolean): RowSelectionState {
    const items = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value]);
    const keys: string[] = [];
    for (const item of items) {
        const id = item && typeof item === 'object' ? (item as { id?: unknown; _id?: unknown }).id ?? (item as { _id?: unknown })._id : item;
        if ((typeof id === 'string' && id) || typeof id === 'number') keys.push(String(id));
    }
    const chosen = multi ? keys : keys.slice(0, 1);
    return Object.fromEntries(chosen.map((key) => [key, true]));
}

/**
 * A data_grid's side of `ui.selection.<id>` (runtime/uiState.ts): the selected
 * rows are published (always a list, re-published only when the selection
 * changes) and a set_ui step can set them. Off outside run mode and on a grid
 * without row selection, so such a grid behaves exactly as before.
 */
export function useGridUiSelection({ nodeId, isRun, selectable, rowSelection, setRowSelection, table }: {
    nodeId: string | undefined;
    isRun: boolean;
    selectable: string;
    rowSelection: RowSelectionState;
    setRowSelection: (next: RowSelectionState) => void;
    table: GridTable;
}): void {
    const enabled = isRun && (selectable === 'single' || selectable === 'multi');
    // A new list on every render; the store compares it row by row, so only a changed selection is news.
    const rows = enabled && Object.keys(rowSelection).length ? table.getSelectedRowModel().rows.map((r) => r.original) : NO_ROWS;
    usePublishedUiState('selection', nodeId, rows, (value) => setRowSelection(selectionFromValue(value, selectable === 'multi')), enabled);
}
