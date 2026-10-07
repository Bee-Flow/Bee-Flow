/**
 * An org member (or several) as a form field: the chosen names in a row
 * that opens the searchable MemberPickerSheet. An unknown stored id reads
 * '—', never the raw id.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, SettingRow, Text } from '@/shared/ui';

import { MemberPickerSheet } from './MemberPickerSheet';
import { useMembers } from '../hooks/members';
import { memberOptions } from '../model/memberOptions';

export interface MemberFieldProps {
    label: string;
    value: string | readonly string[];
    onChange: (next: string | string[]) => void;
    multi?: boolean;
    required?: boolean;
    hint?: string;
    error?: string;
    testID?: string;
}

export function MemberField({ label, value, onChange, multi = false, required = false, hint, error, testID = 'member-field' }: MemberFieldProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const members = useMembers(true);
    const [open, setOpen] = useState(false);
    const ids = typeof value === 'string' ? (value ? [value] : []) : value;
    const labels = new Map(memberOptions(members.data, ids).map((o) => [o.value, o.label]));
    const shown = ids.map((id) => labels.get(id) ?? '—').join(', ');
    return (
        <View style={styles.field}>
            <SettingRow
                testID={testID}
                label={label}
                value={shown || t('compliance.set_no_user', 'Nobody selected')}
                icon={<Icon name={multi ? 'Users' : 'User'} size={18} />}
                onPress={() => setOpen(true)}
            />
            {error ? (
                <Text variant="label" tone="error">
                    {error}
                </Text>
            ) : hint ? (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
            {open ? (
                <MemberPickerSheet title={label} value={value} multi={multi} required={required} onChange={onChange} onClose={() => setOpen(false)} testID={`${testID}-picker`} />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => StyleSheet.create({ field: { gap: theme.spacing.xs, paddingVertical: theme.spacing.xs } });
