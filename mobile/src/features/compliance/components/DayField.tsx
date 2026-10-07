/**
 * A day ('YYYY-MM-DD') without a date-picker dependency (web: <input
 * type="date">, DateInput): presets for the answers people give (today, a
 * week, a month, three months, a year from now), a day back and forward,
 * and the day typed on a numeric keyboard. An optional day can be cleared.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Icon, IconButton, Text, TextField } from '@/shared/ui';

import { addMonthsDay, formatDay, isoDay, parseDay, shiftDay } from '../model/time';

export interface DayFieldProps {
    label: string;
    value: string;
    onChange: (next: string) => void;
    required?: boolean;
    hint?: string;
    error?: string;
    testID?: string;
}

interface Preset {
    id: string;
    label: (t: TranslateFn) => string;
    day: (now: number) => string;
}

const PRESETS: readonly Preset[] = [
    { id: 'today', label: (t) => t('org.academy.today', 'Today'), day: (now) => isoDay(now) },
    { id: 'week', label: (t) => t('mobile.compliance.day_plus_week', '+1 week'), day: (now) => shiftDay('', 7, now) },
    { id: 'month', label: (t) => t('mobile.compliance.day_plus_month', '+1 month'), day: (now) => addMonthsDay(now, 1) },
    { id: 'quarter', label: (t) => t('mobile.compliance.day_plus_months', '+3 months'), day: (now) => addMonthsDay(now, 3) },
    { id: 'year', label: (t) => t('mobile.compliance.day_plus_year', '+1 year'), day: (now) => addMonthsDay(now, 12) },
];

export function DayField({ label, value, onChange, required = false, hint, error, testID = 'day-field' }: DayFieldProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const valid = parseDay(value) !== null;
    return (
        <View style={styles.field} testID={testID}>
            <Text variant="label" tone="secondary">
                {label}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {PRESETS.map((p) => (
                    <Chip key={p.id} testID={`${testID}-preset-${p.id}`} label={p.label(t)} onPress={() => onChange(p.day(Date.now()))} />
                ))}
                {!required && value ? <Chip testID={`${testID}-clear`} label={t('compliance.aa_filter_clear', 'Clear')} onPress={() => onChange('')} /> : null}
            </ScrollView>
            <View style={styles.row}>
                <IconButton
                    testID={`${testID}-prev`}
                    accessibilityLabel={t('mobile.compliance.day_earlier', 'A day earlier')}
                    icon={<Icon name="Minus" size={18} />}
                    onPress={() => onChange(shiftDay(value, -1))}
                />
                <View style={styles.input}>
                    <TextField
                        testID={`${testID}-input`}
                        value={value}
                        onChangeText={onChange}
                        placeholder={t('mobile.compliance.date_placeholder', 'YYYY-MM-DD')}
                        keyboardType="numbers-and-punctuation"
                        maxLength={10}
                        error={error}
                        hint={valid ? formatDay(value) : hint}
                    />
                </View>
                <IconButton
                    testID={`${testID}-next`}
                    accessibilityLabel={t('mobile.compliance.day_later', 'A day later')}
                    icon={<Icon name="Plus" size={18} />}
                    onPress={() => onChange(shiftDay(value, 1))}
                />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        field: { gap: theme.spacing.sm, paddingVertical: theme.spacing.sm },
        chips: { gap: theme.spacing.sm, paddingRight: theme.spacing.lg },
        row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
        input: { flex: 1 },
    });
