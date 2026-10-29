import { useState } from 'react';
import type { ColumnFiltersState, RowSelectionState, SortingState } from '@tanstack/table-core';

/**
 * The tanstack table state of the App Studio data grid that the viewer
 * drives: sort, search, column filters and selection. Moved out of
 * AppDataGrid.tsx verbatim, in the same hook order; the paging state stays
 * there because it resets from the authored pageSize.
 */
export function useGridTableState() {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    return { sorting, setSorting, globalFilter, setGlobalFilter, columnFilters, setColumnFilters, rowSelection, setRowSelection };
}
