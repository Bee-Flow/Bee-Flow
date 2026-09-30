/**
 * A Studio date field. There is no date picker in this app's dependency set,
 * so it is typed as YYYY-MM-DD — the format the app submits — with a "Today"
 * shortcut for the commonest answer. The keyboard is "numeric", which on
 * Android is the number pad with a minus key; "numbers-and-punctuation" is
 * iOS-only and opened Android's letter keyboard.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ root: { gap: theme.spacing.sm } });

/** Today on this phone's calendar: after midnight here it is not yet today in UTC. */
function todayIso(now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function DateInput({
    label,
    value,
    error,
    onChange,
}: {
    label: string;
    value: string | number | boolean | null;
    error: string | null;
    onChange: (next: string | null) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.root}>
            <TextField
                label={label}
                value={value === null ? '' : String(value)}
                onChangeText={(text) => onChange(text || null)}
                placeholder={t('mobile.apps.date_format', 'YYYY-MM-DD')}
                keyboardType="numeric"
                error={error}
                hint={t('mobile.apps.date_hint', 'The app expects a date like 2026-08-29.')}
            />
            <Chip label={t('mobile.apps.date_today', 'Today')} onPress={() => onChange(todayIso())} />
        </View>
    );
}
