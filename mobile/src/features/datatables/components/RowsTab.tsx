/**
 * The Rows tab — the web's RowBrowser: search across the text columns, filter,
 * sort, add a row, and tap one to see or change it. Every narrowing is the
 * server's closed descriptor (rowDescriptor.js), so nothing here can widen
 * what comes back; the next page is asked for with the cursor the last one
 * returned.
 *
 * "Select" turns taps into ticks for one bulk delete (at most 200 rows, one
 * transaction); the answer's `deleted` may be fewer than asked, and the bar
 * says the real number.
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, LoadingState, SearchField } from '@/shared/ui';

import { RowsGrid } from './RowsGrid';
import { RowsSheets, type RowsSheet } from './RowsSheets';
import { RowsToolbar } from './RowsToolbar';
import { SelectionBar } from './SelectionBar';
import { useDatatableRows, useDatatableSchema } from '../hooks/queries';
import { useRowSelection } from '../hooks/useRowSelection';
import { SEARCHABLE_TYPES } from '../model/filters';
import type { Datatable, RowQuery, TableRow } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { flex: 1, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, gap: theme.spacing.sm },
    });

const NO_QUERY: RowQuery = { filters: [], match: 'all', sort: null, q: '' };

function RowsEmpty({ hasColumns, narrowed }: { hasColumns: boolean; narrowed: boolean }) {
    const t = useTranslation();
    const title = !hasColumns
        ? t('datatables.rows_no_columns', 'This table has no columns yet — add some on the Columns tab first.')
        : narrowed
          ? t('datatables.rows_no_match', 'No rows match that search.')
          : t('datatables.rows_empty', 'No rows yet. An automation with a Datatable step writing to this table will fill it, or you can add one here.');
    return <EmptyState icon="Table" title={title} />;
}

/** The search box: submitting asks the server; clearing it asks for every row again. */
function RowSearch({ onSearch }: { onSearch: (q: string) => void }) {
    const t = useTranslation();
    const [text, setText] = useState('');
    return (
        <SearchField
            value={text}
            onChangeText={(next) => {
                setText(next);
                if (!next.trim()) onSearch('');
            }}
            placeholder={t('datatables.rows_search', 'Search the text columns…')}
            onSubmit={() => onSearch(text.trim())}
        />
    );
}

export function RowsTab({ table, canWrite }: { table: Datatable; canWrite: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const [query, setQuery] = useState<RowQuery>(NO_QUERY);
    const [sheet, setSheet] = useState<RowsSheet>(null);
    const selection = useRowSelection();
    const schema = useDatatableSchema(table.id);
    const rows = useDatatableRows(table.id, query);
    const refresh = useUserRefresh(() => rows.refetch());
    const columns = schema.data?.fields ?? [];
    const loaded = rows.data?.pages.flatMap((p) => p.rows) ?? [];
    const { selecting, toggle } = selection;

    const onRowPress = useCallback((row: TableRow) => (selecting ? toggle(row.id) : setSheet({ kind: 'row', row })), [selecting, toggle]);
    const onEndReached = useCallback(() => {
        if (rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
    }, [rows]);
    const onSearch = useCallback((q: string) => setQuery((cur) => (cur.q === q ? cur : { ...cur, q })), []);

    if (schema.isLoading || rows.isLoading) return <LoadingState />;
    if (schema.isError || rows.isError) return <ErrorState error={schema.error ?? rows.error} onRetry={() => void rows.refetch()} />;

    return (
        <View style={styles.root}>
            {columns.some((c) => SEARCHABLE_TYPES.includes(c.type)) ? <RowSearch onSearch={onSearch} /> : null}
            {selecting ? (
                <SelectionBar tableId={table.id} selected={selection.selected} onDone={selection.stop} />
            ) : (
                <RowsToolbar
                    table={table}
                    query={query}
                    shown={loaded.length}
                    canWrite={canWrite && columns.length > 0}
                    onFilter={() => setSheet({ kind: 'filter' })}
                    onSort={() => setSheet({ kind: 'sort' })}
                    onAdd={() => setSheet({ kind: 'row', row: null })}
                    onSelect={selection.start}
                />
            )}
            <RowsGrid
                columns={columns}
                rows={loaded}
                selected={selection.selected}
                empty={<RowsEmpty hasColumns={columns.length > 0} narrowed={query.filters.length > 0 || !!query.q} />}
                loadingMore={rows.isFetchingNextPage}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
                onEndReached={onEndReached}
                onRowPress={onRowPress}
            />
            <RowsSheets sheet={sheet} table={table} columns={columns} canWrite={canWrite} query={query} setQuery={setQuery} onClose={() => setSheet(null)} />
        </View>
    );
}
