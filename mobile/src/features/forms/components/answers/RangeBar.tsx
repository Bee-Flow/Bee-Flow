/**
 * The period the dashboard looks at: the presets, and two dates when "Custom"
 * is chosen (the web's RangeBar). The dates are typed on the "numeric" pad,
 * which on Android has the minus they need ("numbers-and-punctuation" is
 * iOS-only and opened the letter keyboard).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { PRESETS, type AnswersRange, type RangePreset } from '@/features/forms/model/answersRange';
import { Chip, Text, TextField } from '@/shared/ui';


function presetLabel(t: TranslateFn, preset: RangePreset): string {
    const labels: Record<RangePreset, string> = {
        today: t('forms.answers.range_today', 'Today'),
        '7d': t('forms.answers.range_7d', '7 days'),
        '30d': t('forms.answers.range_30d', '30 days'),
        '90d': t('forms.answers.range_90d', '90 days'),
        all: t('forms.answers.range_all', 'All'),
        custom: t('forms.answers.range_custom', 'Custom'),
    };
    return labels[preset];
}

export function RangeBar({ range, onChange, updated }: { range: AnswersRange; onChange: (next: AnswersRange) => void; updated: string | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.box} testID="answers-range">
            <View style={styles.chips} accessibilityLabel={t('forms.answers.range_label', 'Period')}>
                {PRESETS.map((preset) => (
                    <Chip key={preset} label={presetLabel(t, preset)} selected={range.preset === preset} onPress={() => onChange({ ...range, preset })} />
                ))}
            </View>
            {range.preset === 'custom' ? (
                <View style={styles.dates}>
                    <TextField
                        containerStyle={styles.date}
                        label={t('forms.answers.range_from', 'From')}
                        value={range.from}
                        onChangeText={(from) => onChange({ ...range, from })}
                        placeholder={t('mobile.forms.date_format', 'YYYY-MM-DD')}
                        keyboardType="numeric"
                    />
                    <TextField
                        containerStyle={styles.date}
                        label={t('forms.answers.range_to', 'To')}
                        value={range.to}
                        onChangeText={(to) => onChange({ ...range, to })}
                        placeholder={t('mobile.forms.date_format', 'YYYY-MM-DD')}
                        keyboardType="numeric"
                    />
                </View>
            ) : null}
            {updated ? (
                <Text variant="caption" tone="tertiary" testID="answers-updated">
                    {updated}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.sm } satisfies ViewStyle,
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs } satisfies ViewStyle,
    dates: { flexDirection: 'row', gap: theme.spacing.sm } satisfies ViewStyle,
    date: { flex: 1 } satisfies ViewStyle,
});
