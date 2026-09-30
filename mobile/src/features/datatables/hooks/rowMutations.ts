/**
 * Row writes. Every one moves `rowCount` (or `data_version`), so the pages,
 * the table and the list row are read again; the count is the number the
 * column designer prices a destructive change on.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { refreshTable } from './tableMutations';
import { datatableKeys } from '../api/keys';
import { addRow, deleteRow, deleteRows, importRows, updateRow } from '../api/rows';
import type { TableRow } from '../model/types';

function useAfterRowWrite(id: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: datatableKeys.rowsRoot(id) });
        refreshTable(queryClient, id);
    }, [queryClient, id]);
}

export function useAddRow(id: string) {
    const after = useAfterRowWrite(id);
    return useMutation({ mutationFn: (values: Record<string, unknown>) => addRow(id, values), onSuccess: after });
}

/**
 * A 409 `row_conflict` reloads too: the row the sheet held is stale, and the
 * rows as they now are are the answer to "what did they change".
 */
export function useUpdateRow(id: string) {
    const after = useAfterRowWrite(id);
    return useMutation({
        mutationFn: ({ row, values }: { row: TableRow; values: Record<string, unknown> }) => updateRow(id, row, values),
        onSettled: after,
    });
}

export function useDeleteRow(id: string) {
    const after = useAfterRowWrite(id);
    return useMutation({ mutationFn: (rowId: string) => deleteRow(id, rowId), onSuccess: after });
}

export function useDeleteRows(id: string) {
    const after = useAfterRowWrite(id);
    return useMutation({ mutationFn: (ids: string[]) => deleteRows(id, ids), onSuccess: after });
}

/** A 422 (nothing written) still carries the per-line errors; either way the rows are re-read. */
export function useImportRows(id: string) {
    const after = useAfterRowWrite(id);
    return useMutation({
        mutationFn: (rows: Record<string, unknown>[]) => importRows(id, rows),
        onSettled: after,
    });
}
