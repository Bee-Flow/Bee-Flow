/**
 * The editor for ONE column of a row, chosen by the column's type — the web's
 * RowCellEditor for a phone. A choice edits as chips, a yes/no as a switch, a
 * number with the decimal keypad and a date as text in the two spellings the
 * import also reads; a free text box for all of them would let in a value the
 * column cannot hold.
 */

import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Chip, FilterPills, Text, TextField, ToggleRow } from '@/shared/ui';

import { optionPairs } from '../model/cellValues';
import { columnLabel } from '../model/columns';
import type { DraftValue } from '../model/rowDraft';
import type { Column } from '../model/types';

const styles = StyleSheet.create({
    group: { gap: 6 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});

interface Props {
    column: Column;
    value: DraftValue | undefined;
    onChange: (key: string, value: DraftValue) => void;
    error?: string;
    disabled?: boolean;
}

function Label({ column, error }: { column: Column; error?: string }) {
    return (
        <>
            <Text variant="label" tone="secondary">
                {columnLabel(column)}
                {column.required ? ' *' : ''}
            </Text>
            {error ? (
                <Text variant="caption" tone="error">
                    {error}
                </Text>
            ) : null}
        </>
    );
}

/** One of a list, with "—" for none: a value no longer among the choices stays visible. */
function SelectEditor({ column, value, onChange, error, disabled }: Props) {
    const current = typeof value === 'string' ? value : '';
    const options = optionPairs(column);
    const extra = current && !options.some((o) => o.value === current) ? [{ value: current, label: current }] : [];
    return (
        <View style={styles.group}>
            <Label column={column} error={error} />
            <FilterPills<string>
                value={current}
                onChange={(next) => onChange(column.key, next)}
                accessibilityLabel={columnLabel(column)}
                options={[{ value: '', label: '—' }, ...options, ...extra].map((o) => ({ ...o, disabled }))}
            />
        </View>
    );
}

/** Several of a list: every tick is kept locally in the draft, sent as one array. */
function MultiEditor({ column, value, onChange, error, disabled }: Props) {
    const t = useTranslation();
    const picked = Array.isArray(value) ? value : [];
    const options = optionPairs(column);
    const toggle = (v: string) => onChange(column.key, picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
    return (
        <View style={styles.group}>
            <Label column={column} error={error} />
            <View style={styles.chips} accessibilityLabel={columnLabel(column)}>
                {options.length === 0 ? (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.datatables.no_choices', 'This column has no choices yet.')}
                    </Text>
                ) : (
                    options.map((o) => (
                        <Chip key={o.value} label={o.label} selected={picked.includes(o.value)} disabled={disabled} onPress={() => toggle(o.value)} />
                    ))
                )}
            </View>
        </View>
    );
}

function TextEditor({ column, value, onChange, error, disabled }: Props) {
    const t = useTranslation();
    const placeholder =
        column.type === 'date'
            ? t('mobile.datatables.date_placeholder', 'YYYY-MM-DD')
            : column.type === 'datetime'
              ? t('mobile.datatables.datetime_placeholder', 'YYYY-MM-DD HH:mm')
              : undefined;
    return (
        <TextField
            label={`${columnLabel(column)}${column.required ? ' *' : ''}`}
            value={typeof value === 'string' ? value : ''}
            onChangeText={(next) => onChange(column.key, next)}
            error={error}
            placeholder={placeholder}
            editable={!disabled}
            multiline={column.type === 'richtext'}
            keyboardType={column.type === 'number' ? 'decimal-pad' : 'default'}
            autoCapitalize={column.type === 'text' || column.type === 'richtext' ? 'sentences' : 'none'}
            testID={`field-${column.key}`}
        />
    );
}

function FieldEditorView(props: Props) {
    const { column, value, onChange, disabled } = props;
    switch (column.type) {
        case 'bool':
            return (
                <ToggleRow
                    label={columnLabel(column)}
                    value={value === true}
                    onValueChange={(next) => onChange(column.key, next)}
                    disabled={disabled}
                    gutter={false}
                    testID={`field-${column.key}`}
                />
            );
        case 'select':
            return <SelectEditor {...props} />;
        case 'multiselect':
            return <MultiEditor {...props} />;
        default:
            return <TextEditor {...props} />;
    }
}

/** Memoised: typing in one field redraws that field, not every editor in the sheet. */
export const FieldEditor = memo(FieldEditorView);
