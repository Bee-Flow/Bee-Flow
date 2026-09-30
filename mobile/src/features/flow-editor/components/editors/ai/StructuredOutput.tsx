/**
 * The AI step's structured output — the web's StructuredOutputFields and
 * ColumnsEditor (aiStepEditors.jsx): the JSON fields the model returns, each
 * with a type and a note that guides it; a list field can declare its
 * columns, whose ORDER is the table's header order. No fields = free text.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { SelectField } from '@/features/flow-editor/components/fields';
import { COLUMN_TYPES, OUTPUT_FIELD_TYPES, type OutputField } from '@/features/flow-editor/formState';
import { Text, TextField } from '@/shared/ui';

import { AddButton } from '../shared/AddButton';
import { moveAt, patchAt, removeAt } from '../shared/list';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';

/** Example names in the empty boxes: identifiers, not copy. */
const COLUMN_EXAMPLE = 'columnName';
const FIELD_EXAMPLE = 'fieldName';

type Column = { key: string; type: string };

/** A new name, counting up past the ones in use: `field`, `field2`, … */
export function freshName(taken: readonly string[], base: string): string {
    let name = base;
    let i = 1;
    while (taken.includes(name)) name = `${base}${++i}`;
    return name;
}

const typeOptions = (types: readonly string[]) => types.map((v) => ({ value: v, label: v }));

function Columns({ columns, onChange, disabled }: { columns: Column[]; onChange: (next: Column[]) => void; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.columns}>
            <Text variant="label" tone="tertiary">
                {t('mobile.flow.ai.columns', 'Columns')}
            </Text>
            {columns.length === 0 ? (
                <Note>{t('mobile.flow.ai.no_columns', 'No columns — the AI infers the table shape. Add columns to fix the headers, their types, and order.')}</Note>
            ) : null}
            {columns.map((c, i) => (
                <RowCard
                    key={i}
                    title={c.key || t('mobile.flow.ai.column', 'Column')}
                    onMoveUp={i > 0 ? () => onChange(moveAt(columns, i, -1)) : null}
                    onMoveDown={i < columns.length - 1 ? () => onChange(moveAt(columns, i, 1)) : null}
                    onRemove={() => onChange(removeAt(columns, i))}
                    removeLabel={t('mobile.flow.ai.remove_column', 'Remove column')}
                    disabled={disabled}
                >
                    <TextField value={c.key} onChangeText={(key) => onChange(patchAt(columns, i, { key }))} placeholder={COLUMN_EXAMPLE} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
                    <SelectField value={c.type || 'string'} options={typeOptions(COLUMN_TYPES)} onChange={(type) => onChange(patchAt(columns, i, { type }))} disabled={disabled} />
                </RowCard>
            ))}
            <AddButton
                label={t('mobile.flow.ai.add_column', 'Add column')}
                onPress={() => onChange([...columns, { key: freshName(columns.map((c) => c.key), 'column'), type: 'string' }])}
                disabled={disabled}
            />
        </View>
    );
}

export function StructuredOutput({ fields, onChange, disabled = false }: { fields: OutputField[]; onChange: (next: OutputField[]) => void; disabled?: boolean }) {
    const t = useTranslation();
    return (
        <>
            {fields.length === 0 ? (
                <Note>{t('mobile.flow.ai.no_output_fields', 'No fields yet — the AI will return free-form text. Add fields to get a structured JSON response.')}</Note>
            ) : null}
            {fields.map((f, i) => (
                <RowCard
                    key={i}
                    title={f.key || t('mobile.flow.ai.field', 'Field')}
                    onRemove={() => onChange(removeAt(fields, i))}
                    removeLabel={t('mobile.flow.ai.remove_field', 'Remove field')}
                    disabled={disabled}
                    testID={`output-field-${i + 1}`}
                >
                    <TextField value={f.key || ''} onChangeText={(key) => onChange(patchAt(fields, i, { key }))} placeholder={FIELD_EXAMPLE} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
                    <SelectField value={f.type || 'string'} options={typeOptions(OUTPUT_FIELD_TYPES)} onChange={(type) => onChange(patchAt(fields, i, { type }))} disabled={disabled} />
                    <TextField
                        value={f.description || ''}
                        onChangeText={(description) => onChange(patchAt(fields, i, { description }))}
                        placeholder={t('mobile.flow.ai.field_description', 'Description (optional) — guides the model on what to put here')}
                        editable={!disabled}
                    />
                    {f.type === 'array' ? <Columns columns={f.columns || []} onChange={(columns) => onChange(patchAt(fields, i, { columns }))} disabled={disabled} /> : null}
                </RowCard>
            ))}
            <AddButton
                label={t('mobile.flow.ai.add_output_field', 'Add output field')}
                onPress={() => onChange([...fields, { key: freshName(fields.map((f) => f.key), 'field'), type: 'string', description: '' }])}
                disabled={disabled}
                testID="output-field-add"
            />
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    columns: {
        gap: theme.spacing.sm,
        padding: theme.spacing.sm,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
});
