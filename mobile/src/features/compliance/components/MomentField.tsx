/**
 * A moment in the past (web: datetime-local with max = now), without a
 * picker dependency: presets (now, an hour ago, today or yesterday at 09:00)
 * and day / hour / minute steppers, shown as the app writes a moment
 * ('5 Oct 14:03'). It never moves later than five minutes from now — the
 * server refuses an awareness moment in the future. The value is an ISO
 * instant, so the server reads the right hour whatever the zone.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Icon, IconButton, Text } from '@/shared/ui';

import { FUTURE_SLACK_MS } from '../model/fields';
import { formatDayTime } from '../model/time';

export interface MomentFieldProps {
    label: string;
    value: string;
    onChange: (next: string) => void;
    required?: boolean;
    hint?: string;
    error?: string;
    testID?: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function atNine(daysBack: number): number {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
}

const PRESETS: readonly { id: string; label: (t: TranslateFn) => string; at: () => number }[] = [
    { id: 'now', label: (t) => t('cowork.when.chip_now', 'Now'), at: () => Date.now() },
    { id: 'hour', label: (t) => t('mobile.compliance.moment_hour_ago', '1 h ago'), at: () => Date.now() - HOUR },
    { id: 'today', label: (t) => t('mobile.compliance.moment_today_nine', 'Today 09:00'), at: () => atNine(0) },
    { id: 'yesterday', label: (t) => t('mobile.compliance.moment_yesterday_nine', 'Yesterday 09:00'), at: () => atNine(1) },
];

/** A moment no later than now + the slack; past it, now. */
export function capMoment(ms: number, now: number = Date.now()): string {
    return new Date(ms > now + FUTURE_SLACK_MS ? now : ms).toISOString();
}

function Adjuster({ id, label, onStep }: { id: string; label: string; onStep: (sign: 1 | -1) => void }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.adjuster}>
            <IconButton testID={`${id}-down`} accessibilityLabel={`${label} −`} icon={<Icon name="Minus" size={16} />} onPress={() => onStep(-1)} />
            <Text variant="label" tone="secondary">
                {label}
            </Text>
            <IconButton testID={`${id}-up`} accessibilityLabel={`${label} +`} icon={<Icon name="Plus" size={16} />} onPress={() => onStep(1)} />
        </View>
    );
}

export function MomentField({ label, value, onChange, required = false, hint, error, testID = 'moment-field' }: MomentFieldProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const ms = Date.parse(value);
    const set = Number.isNaN(ms) ? null : ms;
    const step = (unit: number) => (sign: 1 | -1) => onChange(capMoment((set ?? Date.now()) + sign * unit));
    return (
        <View style={styles.field} testID={testID}>
            <Text variant="label" tone="secondary">
                {label}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {PRESETS.map((p) => (
                    <Chip key={p.id} testID={`${testID}-preset-${p.id}`} label={p.label(t)} onPress={() => onChange(capMoment(p.at()))} />
                ))}
                {!required && value ? <Chip testID={`${testID}-clear`} label={t('compliance.aa_filter_clear', 'Clear')} onPress={() => onChange('')} /> : null}
            </ScrollView>
            <View style={styles.shown} accessibilityLiveRegion="polite">
                <Text testID={`${testID}-value`} variant="subheading">
                    {set === null ? t('mobile.compliance.moment_unset', 'No moment picked yet') : formatDayTime(new Date(set))}
                </Text>
            </View>
            <View style={styles.steppers}>
                <Adjuster id={`${testID}-day`} label={t('mobile.compliance.moment_day', 'Day')} onStep={step(24 * HOUR)} />
                <Adjuster id={`${testID}-hour`} label={t('mobile.compliance.moment_hour', 'Hour')} onStep={step(HOUR)} />
                <Adjuster id={`${testID}-minute`} label={t('mobile.compliance.moment_minute', 'Minute')} onStep={step(5 * MIN)} />
            </View>
            {error ? (
                <Text variant="label" tone="error">
                    {error}
                </Text>
            ) : hint ? (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        field: { gap: theme.spacing.sm, paddingVertical: theme.spacing.sm },
        chips: { gap: theme.spacing.sm, paddingRight: theme.spacing.lg },
        shown: { padding: theme.spacing.md, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary },
        steppers: { flexDirection: 'row', justifyContent: 'space-between' },
        adjuster: { alignItems: 'center', gap: 2 },
    });
