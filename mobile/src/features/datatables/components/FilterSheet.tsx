/**
 * "Show rows that match" — the web's RowFilterBuilder as a sheet. Conditions
 * are built one at a time (a column, a test from the ones that column can
 * answer, a value), listed, and only sent when applied: building a condition
 * is not the same act as asking for it. A half-typed one is never sent
 * (model/filters.filterEntry).
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Button, FilterPills, IconButton, Icon, Segmented, Sheet, Text, TextField } from '@/shared/ui';

import { columnLabel } from '../model/columns';
import { filterDescriptor, filterEntry, opsForColumn, opTakesList, opTakesNoValue, type FilterDraft } from '../model/filters';
import type { Column, RowQuery } from '../model/types';
import { opLabel } from '../model/words';

const styles = StyleSheet.create({
    condition: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    conditionText: { flex: 1 },
    add: { gap: 8 },
    footer: { gap: 8, paddingBottom: 8 },
});

const blank = (field: string): FilterDraft => ({ field, op: 'eq', value: '' });

export function FilterSheet({
    columns,
    query,
    onApply,
    onClose,
}: {
    columns: readonly Column[];
    query: RowQuery;
    onApply: (next: Pick<RowQuery, 'filters' | 'match'>) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const [rows, setRows] = useState<FilterDraft[]>(() =>
        query.filters.map((f) => ({ field: f.field, op: f.op, value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '') })),
    );
    const [match, setMatch] = useState<RowQuery['match']>(query.match);
    const [draft, setDraft] = useState<FilterDraft>(() => blank(columns[0]?.key ?? ''));
    const column = columns.find((c) => c.key === draft.field) ?? null;
    const ops = opsForColumn(column);
    const nameOf = (key: string) => columnLabel(columns.find((c) => c.key === key) ?? { key });
    const ready = filterEntry(draft) !== null;

    const pickColumn = (key: string) => {
        const next = opsForColumn(columns.find((c) => c.key === key));
        setDraft((d) => ({ field: key, op: next.includes(d.op as never) ? d.op : (next[0] ?? 'eq'), value: d.value }));
    };
    const footer = (
        <View style={styles.footer}>
            <Button fullWidth size="lg" label={rows.length > 1 ? t('datatables.filter_apply_n', 'Apply {n} conditions', { n: rows.length }) : t('datatables.filter_apply', 'Apply')} onPress={() => onApply({ filters: filterDescriptor(rows), match })} testID="filter-apply" />
            <Button fullWidth variant="ghost" label={t('datatables.filter_clear', 'Clear')} onPress={() => onApply({ filters: [], match: 'all' })} />
        </View>
    );

    return (
        <Sheet visible onClose={onClose} title={t('datatables.filter_rows_that', 'Show rows that match')} footer={footer}>
            {rows.length > 1 ? (
                <Segmented<RowQuery['match']>
                    fullWidth
                    value={match}
                    onChange={setMatch}
                    accessibilityLabel={t('datatables.filter_match', 'Match all or any condition')}
                    options={[
                        { value: 'all', label: t('datatables.filter_all', 'all conditions') },
                        { value: 'any', label: t('datatables.filter_any', 'any condition') },
                    ]}
                />
            ) : null}
            {rows.length === 0 ? (
                <Text variant="caption" tone="tertiary">{t('datatables.filter_empty', 'No conditions yet.')}</Text>
            ) : (
                rows.map((r, i) => (
                    <View key={`${r.field}:${r.op}:${i}`} style={styles.condition}>
                        <Icon name="SlidersVertical" size={14} />
                        <Text variant="body" style={styles.conditionText}>
                            {`${nameOf(r.field)} ${opLabel(t, r.op)}${opTakesNoValue(r.op) ? '' : ` ${r.value}`}`}
                        </Text>
                        <IconButton
                            icon={<Icon name="X" size={16} />}
                            accessibilityLabel={t('datatables.filter_remove', 'Remove this condition')}
                            onPress={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                        />
                    </View>
                ))
            )}
            <View style={styles.add}>
                <Text variant="label" tone="secondary">{t('datatables.filter_field', 'Column to filter on')}</Text>
                <FilterPills<string> scroll value={draft.field} onChange={pickColumn} options={columns.map((c) => ({ value: c.key, label: columnLabel(c) }))} />
                <Text variant="label" tone="secondary">{t('datatables.filter_test', 'Test to apply')}</Text>
                <FilterPills<string> value={draft.op} onChange={(op) => setDraft((d) => ({ ...d, op }))} options={ops.map((op) => ({ value: op, label: opLabel(t, op) }))} />
                {opTakesNoValue(draft.op) ? null : (
                    <TextField
                        label={t('datatables.filter_value', 'Value to compare with')}
                        placeholder={opTakesList(draft.op) ? t('datatables.filter_value_list', 'value, value') : t('datatables.filter_value_one', 'value')}
                        value={draft.value}
                        onChangeText={(value) => setDraft((d) => ({ ...d, value }))}
                        autoCapitalize="none"
                        testID="filter-value"
                    />
                )}
                <Button
                    variant="secondary"
                    iconName="Plus"
                    label={t('datatables.filter_add', 'Add a condition')}
                    disabled={!ready}
                    onPress={() => {
                        setRows((cur) => [...cur, draft]);
                        setDraft(blank(draft.field));
                    }}
                    testID="filter-add"
                />
            </View>
        </Sheet>
    );
}
