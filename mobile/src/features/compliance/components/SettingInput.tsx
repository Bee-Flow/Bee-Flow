/**
 * One compliance setting as an input, by the kind the web's field table
 * gives it (model/settingsFields.ts). `relevance` answers go straight to the
 * framework (they are not a settings column); `contacts` is shown, not edited.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Icon, InfoRow, SettingRow, TagInput, Text, TextField, ToggleRow } from '@/shared/ui';

import { ChoiceChips } from './ChoiceChips';
import type { OrgUser } from '../api/readers';
import { formatDate } from '../hooks/useFormatter';
import { labelText } from '../model/fields';
import type { SettingValue } from '../model/settings';
import { RELEVANCE, type SettingField } from '../model/settingsFields';

export interface SettingInputProps {
    field: SettingField;
    value: SettingValue | undefined;
    onChange: (next: SettingValue) => void;
    users: readonly OrgUser[];
    relevance: string | null;
    onRelevance: (next: string) => void;
    contacts: number;
}

function MultiChips({ field, value, onChange }: Pick<SettingInputProps, 'field' | 'value' | 'onChange'>) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const list = Array.isArray(value) ? value : [];
    const toggle = (v: string) => onChange(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    return (
        <View style={styles.field}>
            <Text variant="label" tone="secondary">
                {labelText(field.label, t)}
            </Text>
            <View style={styles.row}>
                {(field.options ?? []).map((o) => (
                    <Chip key={o.value} testID={`setting-${field.name}-${o.value}`} label={labelText(o.label, t)} selected={list.includes(o.value)} onPress={() => toggle(o.value)} />
                ))}
            </View>
        </View>
    );
}

function TextInputField({ field, value, onChange }: Pick<SettingInputProps, 'field' | 'value' | 'onChange'>) {
    const t = useTranslation();
    return (
        <TextField
            testID={`setting-${field.name}`}
            label={labelText(field.label, t)}
            hint={field.hint ? labelText(field.hint, t) : undefined}
            value={typeof value === 'string' ? value : ''}
            onChangeText={onChange}
            placeholder={field.kind === 'date' ? t('mobile.compliance.date_placeholder', 'YYYY-MM-DD') : undefined}
            keyboardType={field.kind === 'number' ? 'numeric' : field.kind === 'email' ? 'email-address' : field.kind === 'url' ? 'url' : 'default'}
            autoCapitalize={field.kind === 'text' ? undefined : 'none'}
        />
    );
}

function StampRow({ field, value, onChange }: Pick<SettingInputProps, 'field' | 'value' | 'onChange'>) {
    const t = useTranslation();
    const when = typeof value === 'string' ? formatDate(value) : null;
    return (
        <SettingRow
            testID={`setting-${field.name}`}
            label={labelText(field.label, t)}
            value={when ? t('compliance.ai_literacy_confirmed_at', 'Confirmed {date} — remember to save', { date: when }) : t('compliance.ai_literacy_never', 'Not confirmed yet')}
            icon={<Icon name="BadgeCheck" size={18} />}
            onPress={() => onChange(new Date().toISOString())}
        />
    );
}

/** The kinds that pick one value from a list: a fixed list, the members, or a framework's relevance. */
function PickOne(props: SettingInputProps) {
    const t = useTranslation();
    const { field, value, onChange } = props;
    const text = typeof value === 'string' ? value : '';
    const hint = field.hint ? labelText(field.hint, t) : undefined;
    const common = { testID: `setting-${field.name}`, label: labelText(field.label, t), hint };
    if (field.kind === 'user') {
        return <ChoiceChips {...common} options={props.users.map((u) => ({ value: u.id, label: u.displayName || u.id }))} value={text} onChange={onChange} />;
    }
    if (field.kind === 'relevance') {
        return <ChoiceChips {...common} options={RELEVANCE.map((o) => ({ value: o.value, label: labelText(o.label, t) }))} value={props.relevance ?? 'unknown'} onChange={props.onRelevance} required />;
    }
    return <ChoiceChips {...common} options={(field.options ?? []).map((o) => ({ value: o.value, label: labelText(o.label, t) }))} value={text} onChange={onChange} />;
}

export function SettingInput(props: SettingInputProps) {
    const t = useTranslation();
    const { field, value, onChange } = props;
    const label = labelText(field.label, t);
    const hint = field.hint ? labelText(field.hint, t) : undefined;
    switch (field.kind) {
        case 'toggle':
            return <ToggleRow testID={`setting-${field.name}`} label={label} description={hint} value={value === true} onValueChange={onChange} />;
        case 'select':
        case 'user':
        case 'relevance':
            return <PickOne {...props} />;
        case 'chips':
            return <MultiChips field={field} value={value} onChange={onChange} />;
        case 'emails':
        case 'strings':
            return (
                <TagInput
                    testID={`setting-${field.name}`}
                    label={label}
                    hint={hint}
                    keyboardType={field.kind === 'emails' ? 'email-address' : undefined}
                    values={Array.isArray(value) ? value : []}
                    onChange={onChange}
                />
            );
        case 'contacts':
            return <InfoRow label={label} value={String(props.contacts)} />;
        case 'stamp':
            return <StampRow field={field} value={value} onChange={onChange} />;
        default:
            return <TextInputField field={field} value={value} onChange={onChange} />;
    }
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        field: { gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] },
    });
