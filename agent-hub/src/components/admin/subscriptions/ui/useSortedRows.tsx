// Click-to-sort for the subscriptions tables on the shared DataTable: the same
// header button and order as the monitoring tables (descending first, again
// for ascending, no order until a header is clicked), but on an accessor per
// column, because the values sit in nested objects (usage, limits).
import { useMemo, useState, type ReactNode } from 'react';
import type { TableColumn } from '@/components/shared/DataTable';
import { SortHeader, type SortDir } from '@/components/admin/monitoring/shared/SortableTable';

type SortValue = string | number | null | undefined;

/** A column of a sortable table: the DataTable column plus, when it sorts, how to read its value. */
export interface SortableColumnDef<Row> extends Omit<TableColumn, 'label' | 'ariaSort'> {
    label: ReactNode;
    sortValue?: (row: Row) => SortValue;
}

function compare(a: SortValue, b: SortValue, dir: SortDir): number {
    const sign = dir === 'desc' ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return sign * (a - b);
    return sign * String(a ?? '').localeCompare(String(b ?? ''));
}

/** The rows in the order the person chose, and the DataTable columns with their sort buttons. */
export function useSortedRows<Row>(rows: Row[], defs: SortableColumnDef<Row>[]): { sorted: Row[]; columns: TableColumn[] } {
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>('desc');
    const onSort = (id: string) => {
        if (sortCol === id) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
        else { setSortCol(id); setSortDir('desc'); }
    };
    const active = defs.find(d => d.id === sortCol && d.sortValue);
    const sorted = useMemo(
        () => (active?.sortValue ? [...rows].sort((a, b) => compare(active.sortValue!(a), active.sortValue!(b), sortDir)) : rows),
        [rows, active, sortDir],
    );
    const columns: TableColumn[] = defs.map(({ sortValue, label, ...col }) => ({
        ...col,
        ariaSort: sortCol === col.id ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined,
        label: sortValue ? <SortHeader label={label} active={sortCol === col.id} dir={sortDir} onSort={() => onSort(col.id)} /> : label,
    }));
    return { sorted, columns };
}
