/**
 * The Rows tab's sheets: one row (add, change, look), the filter, and the
 * sort menu. At most one is open; the tab says which.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { ActionMenu } from '@/shared/ui';

import { FilterSheet } from './FilterSheet';
import { RowSheet } from './RowSheet';
import { columnLabel } from '../model/columns';
import type { Column, Datatable, RowQuery, TableRow } from '../model/types';

export type RowsSheet = { kind: 'row'; row: TableRow | null } | { kind: 'filter' } | { kind: 'sort' } | null;

/** Sorting by a column again flips its direction; a new column starts ascending. */
function sortItems(t: TranslateFn, columns: readonly Column[], query: RowQuery, set: (q: RowQuery) => void) {
    const pick = (field: string) => {
        const again = query.sort?.field === field && query.sort.dir === 'asc';
        set({ ...query, sort: { field, dir: again ? 'desc' : 'asc' } });
    };
    const entries = [...columns.map((c) => ({ key: c.key, name: columnLabel(c) })), { key: 'created_at', name: t('datatables.col_added', 'Added') }];
    return entries.map((e) => ({
        id: e.key,
        label: t('datatables.sort_by', 'Sort by {name}', { name: e.name }),
        selected: query.sort?.field === e.key,
        onPress: () => pick(e.key),
    }));
}

export function RowsSheets({
    sheet,
    table,
    columns,
    canWrite,
    query,
    setQuery,
    onClose,
}: {
    sheet: RowsSheet;
    table: Datatable;
    columns: readonly Column[];
    canWrite: boolean;
    query: RowQuery;
    setQuery: (next: RowQuery) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    return (
        <>
            {sheet?.kind === 'row' ? <RowSheet tableId={table.id} row={sheet.row} columns={columns} canWrite={canWrite} onClose={onClose} /> : null}
            {sheet?.kind === 'filter' ? (
                <FilterSheet
                    columns={columns}
                    query={query}
                    onClose={onClose}
                    onApply={(next) => {
                        setQuery({ ...query, ...next });
                        onClose();
                    }}
                />
            ) : null}
            <ActionMenu visible={sheet?.kind === 'sort'} onClose={onClose} title={table.name} items={sortItems(t, columns, query, setQuery)} />
        </>
    );
}
