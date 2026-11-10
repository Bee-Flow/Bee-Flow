import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import DataTable, { TableCell, TableRow, type TableColumn } from '@/components/shared/DataTable';
import { useTranslation } from '@/hooks/useTranslation';
import type { SortableColumn, SortableTableProps } from '../shared.types';
import { Empty } from './SvgAreaChart';

type SortDir = 'asc' | 'desc';

function compareBy(key: string, dir: SortDir) {
    return (a: object, b: object) => {
        const av = (a as Record<string, unknown>)[key], bv = (b as Record<string, unknown>)[key];
        if (typeof av === 'number' && typeof bv === 'number') return dir === 'desc' ? bv - av : av - bv;
        const as = String(av || ''), bs = String(bv || '');
        return dir === 'desc' ? bs.localeCompare(as) : as.localeCompare(bs);
    };
}

function SortHeader({ label, active, dir, onSort }: { label: ReactNode; active: boolean; dir: SortDir; onSort: () => void }) {
    const Arrow = dir === 'desc' ? ArrowDown : ArrowUp;
    return (
        <button type="button" onClick={onSort} className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
            {label}
            {active && <Arrow className="h-2.5 w-2.5" aria-hidden="true" />}
        </button>
    );
}

/**
 * A table whose sortable columns sort on a click of their header (descending
 * first, again for ascending), on the shared DataTable: the same header row,
 * hairlines and keyboard-operable rows as every other register.
 */
export function SortableTable<Row extends object>({ columns, data, onRowClick, emptyText, maxRows = 50, ariaLabel, testId, flush = false }: SortableTableProps<Row>) {
    const { t } = useTranslation();
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const handleSort = (colKey: string) => {
        if (sortCol === colKey) {
            setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        } else {
            setSortCol(colKey);
            setSortDir('desc');
        }
    };

    const sorted = useMemo(() => (sortCol ? [...data].sort(compareBy(sortCol, sortDir)) : data), [data, sortCol, sortDir]);

    const tableColumns: TableColumn[] = columns.map((col: SortableColumn<Row>) => ({
        id: col.key,
        width: col.width,
        align: col.align === 'right' ? 'right' : undefined,
        ariaSort: sortCol === col.key ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined,
        label: col.sortable !== false
            ? <SortHeader label={col.label} active={sortCol === col.key} dir={sortDir} onSort={() => handleSort(col.key)} />
            : col.label,
    }));

    return (
        <DataTable<Row & { id?: string }>
            columns={tableColumns}
            rows={sorted.slice(0, maxRows) as (Row & { id?: string })[]}
            rowKey={(row, i) => (row as { _key?: string })._key || i}
            ariaLabel={ariaLabel}
            testId={testId}
            flush={flush}
            className={flush ? "-mx-3.5" : ""}
            empty={<Empty text={emptyText ?? t('admin_monitoring.shared_no_data', 'No data')} />}
            renderRow={(row, ctx) => (
                <TableRow columns={tableColumns} onClick={onRowClick ? () => onRowClick(row) : null}>
                    {columns.map((col, j) => (
                        <TableCell key={col.key} column={tableColumns[j]} className="truncate">
                            {col.render ? col.render(row, ctx.index) : (
                                <span className="text-xs text-[var(--text-primary)]">
                                    {(row as Record<string, ReactNode>)[col.key] ?? '—'}
                                </span>
                            )}
                        </TableCell>
                    ))}
                </TableRow>
            )}
        />
    );
}
