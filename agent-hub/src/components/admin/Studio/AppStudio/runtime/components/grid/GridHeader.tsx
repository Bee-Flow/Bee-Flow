import { flexRender } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { ALIGN_CLASS } from '../cellValue';
import GridFilterControl from '../GridFilterControl';
import { isActiveFilter } from '../gridColumnFilters';
import type { GridColumnMeta, GridTable } from './gridTypes';

/**
 * The header rows of the App Studio data grid: the column headings with their
 * sort buttons, and the filter band under them. Moved out of AppDataGrid.jsx
 * verbatim (they were render functions there).
 */

export interface GridHeaderProps {
    table: GridTable;
    selectable: string;
    cellPad: string;
    divider: string;
    minimal: boolean;
    hasRowActions: boolean;
}

export function GridHeaderRow({ table, selectable, cellPad, divider, minimal, hasRowActions }: GridHeaderProps) {
    const { t } = useTranslation();
    return (
        <tr>
            {selectable !== 'none' ? (
                <th className={`${cellPad}${divider} w-9`} style={{ borderColor: 'var(--border-default)' }}>
                    {selectable === 'multi' ? (
                        <input
                            type="checkbox"
                            aria-label={t('studio_apps_runtime.grid.select_all', 'Select all rows')}
                            checked={table.getIsAllRowsSelected()}
                            ref={(el: HTMLInputElement | null) => { if (el) el.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected(); }}
                            onChange={table.getToggleAllRowsSelectedHandler()}
                            className="accent-[var(--app-primary)]"
                        />
                    ) : null}
                </th>
            ) : null}
            {table.getHeaderGroups()[0].headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                // A numeric column's heading belongs over its digits, not over
                // the whitespace to their left.
                const align = (header.column.columnDef.meta as GridColumnMeta | undefined)?.align || 'left';
                // What is actually IN this column, on hover. A heading squeezed
                // to "Snijkw." names the column without saying anything about
                // its contents — and a column of bare 0s and 8s is unreadable
                // to everyone who did not choose those codes.
                const help = (header.column.columnDef.meta as GridColumnMeta | undefined)?.help || undefined;
                return (
                    <th
                        key={header.id}
                        scope="col"
                        title={help}
                        className={`${ALIGN_CLASS[align]} font-medium ${cellPad}${divider} select-none${minimal ? ' text-xs uppercase tracking-wider' : ''}`}
                        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', width: (header.column.columnDef as { size?: number }).size }}
                    >
                        <button
                            type="button"
                            disabled={!sortable}
                            onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                            className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''} ${sortable ? 'cursor-pointer hover:text-[var(--text-primary)]' : 'cursor-default'}`}
                        >
                            <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                            {sortable ? (
                                dir === 'asc' ? <ArrowUp className="w-3 h-3" aria-hidden="true" />
                                    : dir === 'desc' ? <ArrowDown className="w-3 h-3" aria-hidden="true" />
                                        : <ChevronsUpDown className="w-3 h-3 opacity-40" aria-hidden="true" />
                            ) : null}
                        </button>
                    </th>
                );
            })}
            {hasRowActions ? (
                <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} aria-label={t('studio_apps_runtime.grid.actions', 'Actions')} />
            ) : null}
        </tr>
    );
}

// The band under the headings: one typed control per filterable column,
// drawn on a slightly recessed background so it reads as a control row
// rather than as the first record.
export function GridFilterRow({ table, selectable, cellPad, divider, hasRowActions }: Omit<GridHeaderProps, 'minimal'>) {
    const { t } = useTranslation();
    return (
        <tr data-app-grid-filterrow="true" style={{ background: 'var(--bg-secondary)' }}>
            {selectable !== 'none' ? <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} /> : null}
            {table.getHeaderGroups()[0].headers.map((header) => {
                const meta = (header.column.columnDef.meta || {}) as GridColumnMeta;
                // The header's own label, not the raw key — "Filter state" told
                // a screen reader the column's storage name, not its heading.
                const name = t('studio_apps_runtime.grid.filter_column', 'Filter {name}', { name: header.column.columnDef.header || header.column.id });
                const value = header.column.getFilterValue();
                return (
                    <th key={header.id} className={`${cellPad}${divider} font-normal`} style={{ borderColor: 'var(--border-default)' }}>
                        {!header.column.getCanFilter() ? null : (
                            <GridFilterControl
                                kind={meta.filterKind}
                                name={name}
                                value={value}
                                options={meta.filterOptions}
                                active={isActiveFilter(value)}
                                onChange={(next: unknown) => header.column.setFilterValue(next)}
                            />
                        )}
                    </th>
                );
            })}
            {hasRowActions ? <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} /> : null}
        </tr>
    );
}
