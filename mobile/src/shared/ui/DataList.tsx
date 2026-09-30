/**
 * A table for a phone — the web's DataTable (shared/DataTable.jsx): a rounded
 * card with a small shadow, an uppercase tertiary header row, and rows whose
 * columns come from the same `columns` array as the header. Rows are at least
 * 44dp tall; a row may carry a status stripe on its leading edge.
 *
 * Virtualised by default (a FlatList, with the header pinned), because a
 * datatable, a register or an App Studio list can grow without bound. For a
 * short, bounded table inside a scrolling detail screen pass
 * `virtualized={false}`: a FlatList inside a ScrollView is the nesting RN
 * warns about.
 */

import React, { useCallback, useMemo, type ReactElement } from 'react';
import { FlatList, View, type ListRenderItem, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { columnStyle, DataListHeader, DataListRow, type DataColumn } from './DataListRow';
import type { Tone } from './tones';

export type { DataColumn } from './DataListRow';

export interface DataListProps<Row> {
    columns: readonly DataColumn<Row>[];
    rows: readonly Row[];
    /** Defaults to `row.id`, then the index. */
    rowKey?: (row: Row, index: number) => string;
    onRowPress?: (row: Row) => void;
    /** The status stripe for a row, or null for none. */
    rowAccent?: (row: Row) => Tone | null | undefined;
    /** What a screen reader says for a tappable row. */
    rowLabel?: (row: Row) => string;
    /** Shown in place of the rows when there are none (an EmptyState). */
    empty?: ReactElement | null;
    footer?: ReactElement | null;
    virtualized?: boolean;
    /** Pull to refresh, on the virtualised list. */
    refreshing?: boolean;
    onRefresh?: () => void;
    onEndReached?: () => void;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

function defaultKey(row: unknown, index: number): string {
    const id = (row as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : String(index);
}

export function DataList<Row>({
    columns,
    rows,
    rowKey = defaultKey,
    onRowPress,
    rowAccent,
    rowLabel,
    empty = null,
    footer = null,
    virtualized = true,
    refreshing,
    onRefresh,
    onEndReached,
    accessibilityLabel,
    style,
    testID,
}: DataListProps<Row>) {
    const styles = useThemedStyles(makeStyles);
    const cellStyles = useMemo(() => columns.map(columnStyle), [columns]);
    const header = <DataListHeader columns={columns} cellStyles={cellStyles} />;
    // One renderer for the list's lifetime of these props (the Performance
    // rule: a new renderItem per render redraws every mounted row).
    const renderRow = useCallback(
        (row: Row, index: number) => (
            <DataListRow
                key={rowKey(row, index)}
                row={row}
                columns={columns}
                cellStyles={cellStyles}
                onPress={onRowPress}
                accent={rowAccent?.(row)}
                accessibilityLabel={rowLabel?.(row)}
                testID={testID ? `${testID}-row-${index}` : undefined}
            />
        ),
        [rowKey, columns, cellStyles, onRowPress, rowAccent, rowLabel, testID],
    );
    const renderItem = useCallback<ListRenderItem<Row>>(({ item, index }) => renderRow(item, index), [renderRow]);

    if (!virtualized) {
        return (
            <View style={[styles.card, style]} accessibilityLabel={accessibilityLabel} testID={testID}>
                {header}
                {rows.length === 0 ? empty : rows.map(renderRow)}
                {footer}
            </View>
        );
    }

    return (
        <FlatList
            data={rows}
            keyExtractor={rowKey}
            renderItem={renderItem}
            ListHeaderComponent={header}
            stickyHeaderIndices={[0]}
            ListEmptyComponent={empty}
            ListFooterComponent={footer}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onEndReached={onEndReached}
            accessibilityLabel={accessibilityLabel}
            style={[styles.card, style]}
            testID={testID}
        />
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
        overflow: 'hidden',
        boxShadow: theme.shadows.sm,
        flexGrow: 0,
    } satisfies ViewStyle,
});
