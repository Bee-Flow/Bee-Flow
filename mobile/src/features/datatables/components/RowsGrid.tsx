/**
 * The rows, as they actually are: a DataList whose header is the table's own
 * columns, scrolling sideways when there are more than a phone shows, and
 * virtualised downwards — the next keyset page is asked for as the end comes
 * into view, so the phone holds the pages looked at and no more.
 *
 * Selected rows (for a bulk delete) wear the accent stripe.
 */

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { DataList, Spinner, type DataColumn } from '@/shared/ui';

import { cellText } from '../model/cellValues';
import { columnLabel } from '../model/columns';
import { ADDED_WIDTH, columnWidth, gridWidth, stampText } from '../model/grid';
import type { Column, TableRow } from '../model/types';
import { yesNo } from '../model/words';

const styles = StyleSheet.create({ scroller: { flex: 1 }, footer: { padding: 12 } });

const rowKey = (row: TableRow) => row.id;

export function RowsGrid({
    columns,
    rows,
    selected,
    empty,
    loadingMore,
    refreshing,
    onRefresh,
    onEndReached,
    onRowPress,
}: {
    columns: readonly Column[];
    rows: readonly TableRow[];
    selected: ReadonlySet<string>;
    empty: React.ReactElement;
    loadingMore: boolean;
    refreshing: boolean;
    onRefresh: () => void;
    onEndReached: () => void;
    onRowPress: (row: TableRow) => void;
}) {
    const t = useTranslation();
    const layout = useMemo(() => StyleSheet.create({ grid: { width: gridWidth(columns) } }), [columns]);
    const cells = useMemo<DataColumn<TableRow>[]>(() => {
        const words = yesNo(t);
        return [
            ...columns.map((c) => ({
                id: c.key,
                label: columnLabel(c),
                width: columnWidth(c),
                align: c.type === 'number' ? ('right' as const) : undefined,
                render: (row: TableRow) => cellText(row[c.key], c, words),
            })),
            { id: 'created_at', label: t('datatables.col_added', 'Added'), width: ADDED_WIDTH, render: (row: TableRow) => stampText(row.created_at) },
        ];
    }, [columns, t]);
    const label = useMemo(() => {
        const first = columns[0];
        return (row: TableRow) => (first ? `${columnLabel(first)}: ${String(row[first.key] ?? '')}` : row.id);
    }, [columns]);
    const accent = useMemo(() => (row: TableRow) => (selected.has(row.id) ? ('accent' as const) : null), [selected]);

    return (
        <ScrollView horizontal style={styles.scroller} testID="rows-scroller">
            <DataList
                columns={cells}
                rows={rows}
                rowKey={rowKey}
                onRowPress={onRowPress}
                rowAccent={accent}
                rowLabel={label}
                empty={empty}
                footer={loadingMore ? <View style={styles.footer}><Spinner /></View> : null}
                refreshing={refreshing}
                onRefresh={onRefresh}
                onEndReached={onEndReached}
                style={layout.grid}
                testID="rows"
            />
        </ScrollView>
    );
}
