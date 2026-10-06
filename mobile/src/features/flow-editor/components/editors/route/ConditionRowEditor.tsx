/**
 * One row of a condition: [field] [test] [value] — the web's ConditionBuilder
 * row and its ValueSlot. The field is picked by name where the editor knows
 * the fields (the Condition node), or written as an expression (not in
 * Simple mode); the tests offered follow the field's datatype; a test that
 * needs no value asks for none; and where the field is a number, a yes/no or
 * a date, the value is that kind of control until the author asks for a
 * variable instead.
 *
 * A column of a list inside the item ("Mime type" of each attachment) is
 * asked "any / every / no attachment" first (R2), and a File type row takes
 * its value from the list of file types. The notes the row needs (R9, R12)
 * come from ruleHints and are shown under it.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BindingInput, NumberField, SelectField } from '@/features/flow-editor/components/fields';
import { isQuantifiedField, isUnaryOp, operatorsForType, type Binding, type ConditionRow, type Quantifier, type ValueType } from '@/features/flow-editor/model';
import { fileTypeOptions, quantifierLabel, singularName } from '@/features/flow-editor/model/route/ruleLabels';
import { fieldShape } from '@/shared/expr';
import { Button, Icon, IconButton, Text, TextField } from '@/shared/ui';

import { fieldAsExpression, fieldFromExpression } from './conditionState';
import { FieldPicker, type PickOption } from '../shared/FieldPicker';

export interface ConditionRowEditorProps {
    row: ConditionRow;
    index: number;
    type: ValueType;
    onChange: (patch: Partial<ConditionRow>) => void;
    /** A field picked by name: the builder resets the test and the quantifier for it (rowForField). */
    onPickField?: (field: Binding) => void;
    onRemove: (() => void) | null;
    fieldOptions: readonly PickOption[] | null;
    fieldBase: string;
    /** Simple mode: fields by name only, no way into an expression. */
    simple?: boolean;
    /** The notes under the row, already in words. */
    hints?: readonly string[];
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
        control = <NumberField value={v === '' || v == null ? '' : v} allowBlank onChange={(n) => onChange({ kind: 'literal', value: n })} prompt={t('automations.kind.number', 'number')} disabled={disabled} />;
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

function FileTypeValue({ value, onChange, disabled, testID }: { value: unknown; onChange: (b: Binding) => void; disabled?: boolean; testID: string }) {
    const t = useTranslation();
    const key = literalOf(value);
    return (
        <SelectField
            label={t('automations.builder.value_word', 'Value')}
            value={typeof key === 'string' ? key : ''}
            options={[{ value: '', label: t('condition_node.file_type.choose', 'Choose a file type') }, ...fileTypeOptions(t)]}
            onChange={(next) => onChange({ kind: 'literal', value: next })}
            disabled={disabled}
            testID={testID}
        />
    );
}

/** "[any attachment ▾]" before a column of a list inside the item (R2). */
function QuantifierSelect({ row, path, onChange, disabled, testID }: { row: ConditionRow; path: string; onChange: (q: Quantifier) => void; disabled?: boolean; testID: string }) {
    const t = useTranslation();
    const shape = fieldShape(path);
    const list = shape && (shape.kind === 'column' || shape.kind === 'fileList') ? shape.list : '';
    const name = singularName(list) || 'item';
    const quantifiers: Quantifier[] = ['any', 'every', 'none'];
    return (
        <SelectField
            label={t('condition_node.quantifier.aria', 'Which {name}', { name })}
            value={row.quantifier ?? 'any'}
            options={quantifiers.map((q) => ({ value: q, label: quantifierLabel(q, name, t) }))}
            onChange={(q) => onChange(q as Quantifier)}
            disabled={disabled}
            testID={testID}
        />
    );
}

function ValueSlot({ row, type, onChange, disabled, testID }: { row: ConditionRow; type: ValueType; onChange: (b: unknown) => void; disabled?: boolean; testID: string }) {
    const t = useTranslation();
    const [variable, setVariable] = useState(false);
    if (type === 'fileType' && isLiteral(row.value)) return <FileTypeValue value={row.value} onChange={onChange} disabled={disabled} testID={testID} />;
    const typed = !variable && isLiteral(row.value) && (type === 'number' || type === 'boolean' || type === 'date');
    if (typed) return <TypedValue type={type} value={row.value} onChange={onChange} onVariable={() => setVariable(true)} disabled={disabled} />;
    return <BindingInput value={row.value} onChange={onChange} label={t('automations.builder.value_word', 'Value')} prompt={t('mobile.flow.condition.value', 'value')} disabled={disabled} />;
}

/** The row's field: picked by name, or written as an expression (never in Simple mode). */
function FieldSlot(props: ConditionRowEditorProps & { rawField: boolean; onRawField: () => void }) {
    const { row, index, onChange, fieldOptions, fieldBase, simple = false, disabled = false, rawField, onRawField } = props;
    const t = useTranslation();
    const f = row.field && typeof row.field === 'object' ? (row.field as Binding) : null;
    const id = `condition-row-${index + 1}`;
    if (fieldOptions && !rawField && (!f || f.kind === 'ref')) {
        const pick = (path: string) => (props.onPickField ? props.onPickField({ kind: 'ref', path }) : onChange({ field: { kind: 'ref', path } }));
        return (
            <FieldPicker
                label={t('mobile.flow.condition.field', 'Field')}
                path={f?.kind === 'ref' ? f.path : ''}
                onPick={pick}
                options={fieldOptions}
                fallbackBase={fieldBase}
                onUseExpression={simple ? null : onRawField}
                disabled={disabled}
                testID={`${id}-field`}
            />
        );
    }
    // "Use an expression instead" means one: a typed path is a reference (a
    // pill), anything else a formula — never fixed text, which would compare
    // a constant and never match. Once edited it stays this field: cleared to
    // be retyped, it holds the blank reference, which must not swap in the picker.
    return (
        <BindingInput
            mode="expression"
            value={fieldAsExpression(row.field)}
            onChange={(text) => {
                onRawField();
                onChange({ field: fieldFromExpression(String(text ?? '')) });
            }}
            label={t('mobile.flow.condition.field', 'Field')}
            prompt={t('mobile.flow.condition.field_prompt', 'Tap Insert data to pick a field')}
            disabled={disabled}
            testID={`${id}-expr`}
        />
    );
}

export function ConditionRowEditor(props: ConditionRowEditorProps) {
    const { row, index, type, onChange, onRemove, hints = [], disabled = false } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [rawField, setRawField] = useState(false);
    const path = row.field && typeof row.field === 'object' && (row.field as Binding).kind === 'ref' ? String((row.field as { path?: string }).path || '') : '';
    const ops = operatorsForType(type, row.op, { quantified: !!row.quantifier, t });
    const id = `condition-row-${index + 1}`;
    return (
        <View style={styles.row} testID={id}>
            {row.quantifier || isQuantifiedField(path) ? (
                <QuantifierSelect row={row} path={path} onChange={(quantifier) => onChange({ quantifier })} disabled={disabled} testID={`${id}-quantifier`} />
            ) : null}
            <FieldSlot {...props} rawField={rawField} onRawField={() => setRawField(true)} />
            <SelectField
                label={t('mobile.flow.condition.test', 'Test')}
                value={row.op}
                options={ops.map((o) => ({ value: o.key, label: o.label }))}
                onChange={(op) => onChange({ op })}
                disabled={disabled}
                testID={`${id}-op`}
            />
            {isUnaryOp(row.op) ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.condition.no_value', 'no value needed')}
                </Text>
            ) : (
                <ValueSlot row={row} type={type} onChange={(value) => onChange({ value })} disabled={disabled} testID={`${id}-value`} />
            )}
            {hints.map((hint) => (
                <Text key={hint} variant="caption" tone="warning">
                    {hint}
                </Text>
            ))}
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
