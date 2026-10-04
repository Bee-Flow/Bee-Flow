/**
 * One declared parameter: its binding name, type, description and whether it
 * is required — the web's FieldRow in fieldDesigner.jsx. The name box keeps
 * its own text while the author types and COMMITS on submit or when it loses
 * focus, so `email` on the way to `email_address` is never stored, never
 * saved, and never rewrites the automation along the way. Leaving the editor
 * with the box still focused commits too.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { SelectField, ToggleField, useCommitText } from '@/features/flow-editor/components/fields';
import { Text, TextField } from '@/shared/ui';

import { applyBindingRename, nameProblem, PLACEHOLDER_NAME_RE, type ParamRow as Row } from './paramsModel';
import { say } from '../declarative/runtime';
import type { Msg, OptionSpec } from '../declarative/spec';
import { RowCard } from '../shared/RowCard';

export interface ParamRowProps {
    row: Row;
    position: number;
    siblings: readonly Row[];
    types: readonly OptionSpec[];
    removeLabel: string;
    descriptionPlaceholder: string | null;
    sanitizeName: ((s: string) => string) | null;
    takenError: Msg;
    carry: ((from: string, to: string) => number | undefined) | null;
    onPatch: (patch: Partial<Row>) => void;
    onRemove: () => void;
    disabled: boolean;
}

/**
 * The name box, plus the note a committed rename leaves (what it carried
 * along), cleared on the next keystroke. The note survives the box adopting
 * an outside change: a committed rename comes back as exactly such a change.
 */
function useNameBox(name: string, commitName: (text: string) => { error: Msg | null; note: Msg | null }) {
    const [note, setNote] = useState<Msg | null>(null);
    const box = useCommitText<Msg>(name, (typed) => {
        const out = commitName(typed);
        setNote(out.error ? null : out.note);
        return { error: out.error };
    });
    const change = (next: string) => {
        box.change(next);
        setNote(null);
    };
    return { ...box, note, change };
}

export function ParamRow(props: ParamRowProps) {
    const { row, position, siblings, types, takenError, carry, onPatch, disabled } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const name = row.name || '';
    const box = useNameBox(name, (typed) => {
        const out = applyBindingRename({ from: name, to: typed, siblings, carry, takenError, orphanNote: !PLACEHOLDER_NAME_RE.test(name) });
        if (out.ok) onPatch({ name: out.name });
        return { error: out.error, note: out.unchanged ? null : out.note };
    });
    const stored = box.error ? null : nameProblem(row.name);
    return (
        <RowCard title={name || t('mobile.flow.params.unnamed', 'Unnamed')} onRemove={props.onRemove} removeLabel={props.removeLabel} disabled={disabled}>
            <TextField
                label={t('common.name', 'Name')}
                value={box.text}
                onChangeText={(v) => box.change(props.sanitizeName ? props.sanitizeName(v) : v)}
                onBlur={box.commit}
                onSubmitEditing={box.commit}
                placeholder={t('mobile.flow.params.name_placeholder', 'name')}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                error={box.error ? say(t, box.error) : null}
                accessibilityLabel={t('mobile.flow.params.name_aria', 'Field {n} name', { n: position })}
            />
            {!box.error && box.note ? (
                <Text variant="caption" tone="secondary">
                    {say(t, box.note)}
                </Text>
            ) : null}
            {stored ? (
                <Text variant="caption" tone="warning">
                    {say(t, stored)}
                </Text>
            ) : null}
            <SelectField
                label={t('common.type', 'Type')}
                value={row.type || 'string'}
                options={types.map((o) => ({ value: o.value, label: say(t, o.label) }))}
                onChange={(type) => onPatch({ type })}
                disabled={disabled}
            />
            {props.descriptionPlaceholder !== null ? (
                <TextField
                    label={t('common.description', 'Description')}
                    value={row.description || ''}
                    onChangeText={(description) => onPatch({ description })}
                    placeholder={props.descriptionPlaceholder}
                    editable={!disabled}
                />
            ) : null}
            <View style={styles.required}>
                <ToggleField value={!!row.required} onChange={(required) => onPatch({ required })} label={t('mobile.flow.params.required', 'required')} disabled={disabled} />
            </View>
        </RowCard>
    );
}

const makeStyles = (theme: Theme) => ({
    required: { marginTop: -theme.spacing.xs } satisfies ViewStyle,
});
