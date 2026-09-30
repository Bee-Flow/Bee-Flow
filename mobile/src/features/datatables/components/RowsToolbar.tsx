/** The row list's toolbar: how much is shown, then Filter, Sort, Select and Add a row. */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Button, Text } from '@/shared/ui';

import type { Datatable, RowQuery } from '../model/types';
import { rowsWord } from '../model/words';

const styles = StyleSheet.create({
    root: { gap: 6 },
    buttons: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});

export function RowsToolbar({
    table,
    query,
    shown,
    canWrite,
    onFilter,
    onSort,
    onAdd,
    onSelect,
}: {
    table: Datatable;
    query: RowQuery;
    shown: number;
    canWrite: boolean;
    onFilter: () => void;
    onSort: () => void;
    onAdd: () => void;
    onSelect: () => void;
}) {
    const t = useTranslation();
    const n = query.filters.length;
    // row_count is arithmetic, so "of N" is approximate between retention sweeps.
    const window =
        shown < table.rowCount && !n && !query.q
            ? t('datatables.rows_recent', 'the {n} most recent of {total}', { n: shown, total: table.rowCount.toLocaleString() })
            : rowsWord(t, shown);
    return (
        <View style={styles.root}>
            <Text variant="caption" tone="tertiary" testID="rows-window">
                {window}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.buttons}>
                <Button
                    size="sm"
                    variant={n ? 'primary' : 'secondary'}
                    iconName="SlidersVertical"
                    label={n ? t('datatables.filter_n', 'Filter ({n})', { n }) : t('datatables.filter', 'Filter')}
                    onPress={onFilter}
                    testID="rows-filter"
                />
                <Button size="sm" variant="secondary" iconName="ListOrdered" label={t('mobile.datatables.sort', 'Sort')} onPress={onSort} testID="rows-sort" />
                {canWrite ? (
                    <>
                        <Button size="sm" variant="secondary" iconName="SquareCheckBig" label={t('mobile.datatables.select', 'Select')} onPress={onSelect} />
                        <Button size="sm" iconName="Plus" label={t('datatables.add_row', 'Add a row')} onPress={onAdd} testID="rows-add" />
                    </>
                ) : null}
            </ScrollView>
        </View>
    );
}
