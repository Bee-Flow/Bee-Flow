/**
 * A question's binding name — `<base>.<name>`, what later steps read — in its
 * Advanced fold, the web's BindingNameField (fieldDesigner.jsx). Where the
 * editor can rewrite the routine (`rename`), the name is editable and the
 * rename carries every step that binds it, in the same edit, saying how many
 * moved; where it cannot, the name is shown and said to be fixed here.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FormField } from '@/features/flow-editor/model';
import { Button, Text, TextField } from '@/shared/ui';

import { say } from '../declarative/runtime';
import { msg, type Msg } from '../declarative/spec';
import { applyBindingRename } from '../params/paramsModel';

export interface BindingNameProps {
    field: FormField;
    siblings: readonly FormField[];
    bindingBase: string;
    rename?: ((from: string, to: string) => number | undefined) | null;
    onChange: (patch: Partial<FormField>) => void;
    disabled?: boolean;
}

const TAKEN = msg('mobile.flow.form.name_taken', 'Another question on this page already binds that name.');

export function BindingName({ field, siblings, bindingBase, rename, onChange, disabled = false }: BindingNameProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [draft, setDraft] = useState(field.name);
    const [error, setError] = useState<Msg | null>(null);
    const [note, setNote] = useState<Msg | null>(null);
    const [seen, setSeen] = useState(field.name);
    if (seen !== field.name) {
        setSeen(field.name);
        setDraft(field.name);
        setError(null);
    }
    if (!rename) {
        return (
            <View style={styles.block}>
                <Text variant="label" tone="tertiary">
                    {t('mobile.flow.form.binding_name', 'Binding name')}
                </Text>
                <Text variant="code" selectable>{`${bindingBase}.${field.name}`}</Text>
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.flow.form.binding_fixed',
                        'Fixed here. Rename it from the routine that uses this form — there the rename can carry every step that binds it along with it.',
                    )}
                </Text>
            </View>
        );
    }
    const apply = () => {
        const out = applyBindingRename({ from: field.name, to: draft, siblings, carry: rename, takenError: TAKEN });
        if (out.unchanged) return;
        if (!out.ok) return setError(out.error);
        setError(null);
        onChange({ name: out.name });
        setNote(out.note);
    };
    return (
        <View style={styles.block}>
            <TextField
                label={t('mobile.flow.form.binding_name', 'Binding name')}
                hint={`${bindingBase}.`}
                value={draft}
                onChangeText={(v) => {
                    setDraft(v);
                    setError(null);
                    setNote(null);
                }}
                onSubmitEditing={apply}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                error={error ? say(t, error) : null}
                accessibilityLabel={t('mobile.flow.form.binding_name_for', 'Binding name for {name}', { name: field.label || field.name })}
            />
            <View style={styles.row}>
                <Button size="sm" variant="secondary" label={t('mobile.flow.form.rename', 'Rename')} onPress={apply} disabled={disabled || draft === field.name} />
            </View>
            <Text variant="caption" tone={note ? 'secondary' : 'tertiary'}>
                {note
                    ? say(t, note)
                    : t('mobile.flow.form.rename_hint', 'Renaming rewrites every step that binds this answer, in the same edit. Changing the QUESTION above never touches it.')}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    block: { gap: theme.spacing.xs } satisfies ViewStyle,
    row: { flexDirection: 'row' } satisfies ViewStyle,
});
