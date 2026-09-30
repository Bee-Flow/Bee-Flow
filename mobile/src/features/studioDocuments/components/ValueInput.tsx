/**
 * A customer value for one parameter (the web's ValueInput): yes/no, one of
 * the choices, a list of rows — an invoice's line items, with the sum of
 * every number column under them — or a text, number or date.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Button, FilterPills, Text } from '@/shared/ui';

import { makeEditorStyles } from './editorStyles';
import { TypedValueField, YesNoPicker } from './ParamFields';
import type { ContractParameter } from '../model/types';
import { columnTotals, formatTotal, listRows, removeAt, setRowField } from '../model/values';

export interface ValueInputProps {
    parameter: ContractParameter;
    label: string;
    value: unknown;
    onChange: (next: unknown) => void;
}

function ListValueInput({ parameter, label, value, onChange }: ValueInputProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    const rows = listRows(value);
    const fields = parameter.fields ?? [];
    const totals = columnTotals(fields, rows);
    return (
        <View style={styles.block}>
            <Text variant="label" weight="semibold" tone="tertiary">
                {label}
            </Text>
            {rows.map((row, index) => (
                // Keyed by the row count too: the fields keep their own text, and
                // a removed row must not leave its text in the next one.
                <View key={`${index}/${rows.length}`} style={styles.card}>
                    {fields.map((field) => (
                        <ValueInput
                            key={field.key}
                            parameter={field}
                            label={field.label || field.key}
                            value={row[field.key]}
                            onChange={(next) => onChange(setRowField(rows, index, field.key, next))}
                        />
                    ))}
                    <Button label={t('mobile.studio_documents.values.remove_row', 'Remove row')} onPress={() => onChange(removeAt(rows, index))} variant="ghost" size="sm" />
                </View>
            ))}
            <Button label={t('mobile.studio_documents.values.add_row', 'Row')} iconName="Plus" variant="secondary" onPress={() => onChange([...rows, {}])} />
            {rows.length
                ? totals.map((total) => (
                      <Text key={total.key} variant="caption" tone="secondary" testID={`total-${parameter.key}-${total.key}`}>
                          {t('mobile.studio_documents.values.total', 'Sum of {label}: {total}', { label: total.label, total: formatTotal(total.total) })}
                      </Text>
                  ))
                : null}
        </View>
    );
}

export function ValueInput(props: ValueInputProps) {
    const { parameter, label, value, onChange } = props;
    if (parameter.type === 'list') return <ListValueInput {...props} />;
    if (parameter.type === 'boolean') {
        return (
            <View>
                <Text variant="caption" tone="secondary">
                    {label}
                </Text>
                <YesNoPicker label={label} value={value} onChange={onChange} />
            </View>
        );
    }
    if (parameter.type === 'choice') {
        return (
            <View>
                <Text variant="caption" tone="secondary">
                    {label}
                </Text>
                <FilterPills
                    value={typeof value === 'string' ? value : ''}
                    onChange={onChange}
                    options={(parameter.options ?? []).map((o) => ({ value: o, label: o }))}
                    accessibilityLabel={label}
                />
            </View>
        );
    }
    return <TypedValueField type={parameter.type} label={label} value={value} onChange={onChange} />;
}
