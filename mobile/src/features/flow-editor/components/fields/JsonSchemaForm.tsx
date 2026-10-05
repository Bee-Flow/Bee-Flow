/**
 * A tool's inputs, laid out from its catalog input schema — the web's
 * ToolInputForm (agent-hub `Builder/mapping/ToolInputForm.jsx`), whose model
 * is schemaForm/model.ts. The fields that make the call work show first; the
 * rest sit behind "Show all options"; inputs the schema does not declare are
 * listed as extra rows. Without a schema (a custom tool) it is key/value rows.
 *
 * A declared option list is a picker. Every other field is a BindingInput, so
 * a value can be typed or picked from an earlier step. A field auto-map filled
 * says so until the author changes it.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { BindingValue, JsonSchema } from '@/features/flow-editor/bindings';
import { buildSchemaFormModel, updateInput, type Inputs, type SchemaFormField } from '@/features/flow-editor/schemaForm';
import { Button } from '@/shared/ui';

import { BindingInput } from './BindingInput';
import { RowsEditor } from './RowsEditor';
import { SelectField } from './SelectField';

export interface JsonSchemaFormProps {
    inputSchema: JsonSchema | null | undefined;
    inputs: Inputs | null | undefined;
    onChange: (next: Inputs) => void;
    /** Keys auto-map filled (`step.autoMapped`). */
    autoMappedKeys?: readonly string[];
    /** Offer "Auto-map": fill the empty inputs from the data upstream. */
    onAutoMap?: () => void;
    /** Inputs the schema does not declare may be added (additionalProperties). */
    allowExtra?: boolean;
    disabled?: boolean;
}

/** An enum option as the value a picker shows, and the stored literal back. */
export function enumValue(binding: unknown): string {
    const b = binding as { kind?: string; value?: unknown } | null;
    return b && b.kind === 'literal' && b.value != null ? String(b.value) : '';
}

function SchemaField({ field, onChange, disabled }: { field: SchemaFormField; onChange: (b: BindingValue) => void; disabled: boolean }) {
    const t = useTranslation();
    const auto = field.autoMapped ? t('mobile.flow.input.auto', 'Filled in automatically') : null;
    const hint = [field.hint, auto].filter(Boolean).join(' · ') || null;
    if (field.options) {
        const options = [
            { value: '', label: t('common.none', 'None') },
            ...field.options.map((o) => ({ value: String(o), label: String(o) })),
        ];
        return (
            <SelectField
                label={field.label}
                hint={hint}
                required={field.required}
                value={enumValue(field.value)}
                options={options}
                disabled={disabled}
                onChange={(v) => onChange(v === '' ? null : { kind: 'literal', value: field.options?.find((o) => String(o) === v) ?? v })}
            />
        );
    }
    return (
        <BindingInput
            label={field.label}
            hint={hint}
            prompt={field.placeholder}
            required={field.required}
            multiline={field.multiline}
            value={field.value}
            onChange={(b) => onChange(b as BindingValue)}
            disabled={disabled}
            testID={`input-${field.key}`}
        />
    );
}

function MoreToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!count) return null;
    return (
        <View style={styles.row}>
            <Button
                size="sm"
                variant="ghost"
                iconName={open ? 'ChevronUp' : 'ChevronDown'}
                label={
                    open
                        ? t('automations.builder.show_fewer_options', 'Show fewer options')
                        : t('automations.builder.show_advanced_n', 'Show advanced options ({count})', { count })
                }
                onPress={onToggle}
            />
        </View>
    );
}

function AutoMapButton({ onPress }: { onPress?: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!onPress) return null;
    return (
        <View style={styles.row}>
            <Button size="sm" variant="secondary" iconName="Sparkles" label={t('automations.ndv.tables_row.automap', 'Auto-map')} onPress={onPress} />
        </View>
    );
}

export function JsonSchemaForm(props: JsonSchemaFormProps) {
    const { inputSchema, inputs, onChange, onAutoMap } = props;
    const disabled = props.disabled === true;
    const allowExtra = props.allowExtra !== false && !disabled;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [showAll, setShowAll] = useState(false);
    const [consumed, setConsumed] = useState<ReadonlySet<string>>(new Set());
    const current = inputs || {};
    const model = buildSchemaFormModel({ inputSchema, inputs: current, autoMappedKeys: props.autoMappedKeys, consumedKeys: consumed });
    const set = (key: string) => (b: BindingValue) => {
        setConsumed((prev) => new Set(prev).add(key));
        onChange(updateInput(current, key, b));
    };
    const field = (f: SchemaFormField) => <SchemaField key={f.key} field={f} onChange={set(f.key)} disabled={disabled} />;
    const autoMap = <AutoMapButton onPress={disabled ? undefined : onAutoMap} />;

    if (model.mode === 'generic') {
        return (
            <View style={styles.body}>
                {autoMap}
                <RowsEditor value={current} onChange={onChange} disabled={disabled} />
            </View>
        );
    }
    const extras = model.rows.map((r) => r.key);
    return (
        <View style={styles.body}>
            {autoMap}
            {model.essential.map(field)}
            <MoreToggle count={model.advanced.length} open={showAll} onToggle={() => setShowAll((v) => !v)} />
            {showAll ? model.advanced.map(field) : null}
            {extras.length || allowExtra ? (
                <RowsEditor
                    value={current}
                    keys={extras}
                    onChange={onChange}
                    disabled={!allowExtra}
                    label={extras.length ? t('mobile.flow.input.extra', 'Other inputs') : undefined}
                />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.lg } satisfies ViewStyle,
    row: { flexDirection: 'row' } satisfies ViewStyle,
});
