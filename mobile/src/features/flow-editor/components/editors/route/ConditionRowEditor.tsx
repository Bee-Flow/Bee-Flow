/**
 * One row of a condition: [field] [test] [value] — the web's ConditionBuilder
 * row and its ValueSlot. The field is picked by name where the editor knows
 * the fields (the Condition node), or written as an expression; the tests offered
 * follow the field's datatype; a test that needs no value asks for none; and
 * where the field is a number, a yes/no or a date, the value is that kind of
 * control until the author asks for a variable instead.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BindingInput, NumberField, SelectField } from '@/features/flow-editor/components/fields';
import { isUnaryOp, operatorsForType, type Binding, type ConditionRow, type ValueType } from '@/features/flow-editor/model';
import { Button, Icon, IconButton, Text, TextField } from '@/shared/ui';

import { fieldAsExpression, fieldFromExpression } from './conditionState';
import { FieldPicker, type PickOption } from '../shared/FieldPicker';

export interface ConditionRowEditorProps {
    row: ConditionRow;
    index: number;
    type: ValueType;
    onChange: (patch: Partial<ConditionRow>) => void;
    onRemove: (() => void) | null;
    fieldOptions: readonly PickOption[] | null;
    fieldBase: string;
    disabled?: boolean;
}

const literalOf = (value: unknown): unknown => (value && typeof value === 'object' && (value as Binding).kind === 'literal' ? (value as { value: unknown }).value : '');
const isLiteral = (value: unknown) => !value || typeof value !== 'object' || (value as Binding).kind == null || (value as Binding).kind === 'literal';

function TypedValue({ type, value, onChange, onVariable, disabled }: { type: ValueType; value: unknown; onChange: (b: Binding) => void; onVariable: () => void; disabled?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const v = literalOf(value);
    let control: React.ReactNode;
    if (type === 'number') {
        control = <NumberField value={v === '' || v == null ? '' : v} allowBlank onChange={(n) => onChange({ kind: 'literal', value: n })} prompt={t('routines.kind.number', 'number')} disabled={disabled} />;
    } else if (type === 'boolean') {
        control = (
            <SelectField
                value={v === true ? 'true' : v === false ? 'false' : ''}
                options={[
                    { value: '', label: t('mobile.flow.condition.choose', '(choose)') },
                    { value: 'true', label: t('mobile.flow.condition.true', 'true') },
                    { value: 'false', label: t('mobile.flow.condition.false', 'false') },
                ]}
                onChange={(s) => onChange({ kind: 'literal', value: s === '' ? '' : s === 'true' })}
                disabled={disabled}
            />
        );
    } else {
        control = <TextField value={typeof v === 'string' ? v : ''} onChangeText={(s) => onChange({ kind: 'literal', value: s })} placeholder="2026-01-31" autoCapitalize="none" editable={!disabled} />;
    }
    return (
        <View style={styles.typed}>
            <View style={styles.grow}>{control}</View>
            <IconButton icon={<Icon name="Braces" size={16} color={styles.glyph.color} />} onPress={onVariable} disabled={disabled} accessibilityLabel={t('mobile.flow.condition.use_variable', 'Use a variable instead')} />
        </View>
    );
}

function ValueSlot({ row, type, onChange, disabled }: { row: ConditionRow; type: ValueType; onChange: (b: unknown) => void; disabled?: boolean }) {
    const t = useTranslation();
    const [variable, setVariable] = useState(false);
    const typed = !variable && isLiteral(row.value) && (type === 'number' || type === 'boolean' || type === 'date');
    if (typed) return <TypedValue type={type} value={row.value} onChange={onChange} onVariable={() => setVariable(true)} disabled={disabled} />;
    return <BindingInput value={row.value} onChange={onChange} label={t('routines.builder.value_word', 'Value')} prompt={t('mobile.flow.condition.value', 'value')} disabled={disabled} />;
}

export function ConditionRowEditor({ row, index, type, onChange, onRemove, fieldOptions, fieldBase, disabled = false }: ConditionRowEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [rawField, setRawField] = useState(false);
    const f = row.field && typeof row.field === 'object' ? (row.field as Binding) : null;
    const byName = !!fieldOptions && !rawField && (!f || f.kind === 'ref');
    const ops = operatorsForType(type, row.op, t);
    return (
        <View style={styles.row} testID={`condition-row-${index + 1}`}>
            {byName ? (
                <FieldPicker
                    label={t('mobile.flow.condition.field', 'Field')}
                    path={f?.kind === 'ref' ? f.path : ''}
                    onPick={(path) => onChange({ field: { kind: 'ref', path } })}
                    options={fieldOptions ?? []}
                    fallbackBase={fieldBase}
                    onUseExpression={() => setRawField(true)}
                    disabled={disabled}
                    testID={`condition-row-${index + 1}-field`}
                />
            ) : (
                // "Use an expression instead" means one: a typed path is a
                // reference (a pill), anything else a formula — never fixed
                // text, which would compare a constant and never match. Once
                // edited it stays this field: cleared to be retyped, it holds
                // the blank reference, which must not swap in the picker.
                <BindingInput
                    mode="expression"
                    value={fieldAsExpression(row.field)}
                    onChange={(text) => {
                        setRawField(true);
                        onChange({ field: fieldFromExpression(String(text ?? '')) });
                    }}
                    label={t('mobile.flow.condition.field', 'Field')}
                    prompt={t('mobile.flow.condition.field_prompt', 'Tap Insert data to pick a field')}
                    disabled={disabled}
                    testID={`condition-row-${index + 1}-expr`}
                />
            )}
            <SelectField
                label={t('mobile.flow.condition.test', 'Test')}
                value={row.op}
                options={ops.map((o) => ({ value: o.key, label: o.label }))}
                onChange={(op) => onChange({ op })}
                disabled={disabled}
                testID={`condition-row-${index + 1}-op`}
            />
            {isUnaryOp(row.op) ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.condition.no_value', 'no value needed')}
                </Text>
            ) : (
                <ValueSlot row={row} type={type} onChange={(value) => onChange({ value })} disabled={disabled} />
            )}
            {onRemove ? <Button size="sm" variant="ghost" iconName="Trash2" label={t('mobile.flow.condition.remove', 'Remove condition')} onPress={onRemove} disabled={disabled} /> : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        gap: theme.spacing.sm,
        paddingLeft: theme.spacing.sm,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    typed: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    grow: { flex: 1 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});
