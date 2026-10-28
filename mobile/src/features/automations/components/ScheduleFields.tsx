/** The five-shape schedule editor: how often, which day, and at what time. */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

import { Stepper } from './Stepper';
import { WEEKDAYS, pad, type SimpleSchedule, type SimpleScheduleKind } from '../model/cron';

const KINDS: { value: SimpleScheduleKind; i18nKey: string; en: string }[] = [
    { value: 'hourly', i18nKey: 'cowork.repeat.hourly', en: 'Every hour' },
    { value: 'daily', i18nKey: 'cowork.repeat.daily', en: 'Every day' },
    { value: 'weekdays', i18nKey: 'automations.repeating.cadenceWeekdays', en: 'Weekdays' },
    { value: 'weekly', i18nKey: 'automations.cadence_weekly', en: 'Weekly' },
    { value: 'monthly', i18nKey: 'automations.cadence_monthly', en: 'Monthly' },
];

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        group: { gap: theme.spacing.sm },
        chips: { gap: theme.spacing.sm, paddingRight: theme.spacing.lg },
        times: { flexDirection: 'row', gap: theme.spacing.md },
        half: { flex: 1 },
    });

type Update = (change: (s: SimpleSchedule) => SimpleSchedule) => void;

function TimeSteppers({ schedule, update }: { schedule: SimpleSchedule; update: Update }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.times}>
            {schedule.kind !== 'hourly' ? (
                <Stepper
                    label={t('mobile.automations.schedule.hour', 'Hour')}
                    value={pad(schedule.hour)}
                    onDecrement={() => update((s) => ({ ...s, hour: (s.hour + 23) % 24 }))}
                    onIncrement={() => update((s) => ({ ...s, hour: (s.hour + 1) % 24 }))}
                    style={styles.half}
                />
            ) : null}
            <Stepper
                label={
                    schedule.kind === 'hourly'
                        ? t('mobile.automations.schedule.minutes_past', 'Minutes past the hour')
                        : t('mobile.automations.schedule.minute', 'Minute')
                }
                value={pad(schedule.minute)}
                onDecrement={() => update((s) => ({ ...s, minute: (s.minute + 55) % 60 }))}
                onIncrement={() => update((s) => ({ ...s, minute: (s.minute + 5) % 60 }))}
                style={styles.half}
            />
        </View>
    );
}

export function ScheduleFields({ schedule, update }: { schedule: SimpleSchedule; update: Update }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <>
            <View style={styles.group}>
                <Text variant="caption" tone="secondary" weight="medium">
                    {t('automations.settings.frequency', 'How often')}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                    {KINDS.map((k) => (
                        <Chip
                            key={k.value}
                            label={t(k.i18nKey, k.en)}
                            selected={schedule.kind === k.value}
                            onPress={() => update((s) => ({ ...s, kind: k.value }))}
                        />
                    ))}
                </ScrollView>
            </View>

            {schedule.kind === 'weekly' ? (
                <View style={styles.group}>
                    <Text variant="caption" tone="secondary" weight="medium">
                        {t('mobile.automations.schedule.which_day', 'On which day')}
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                        {WEEKDAYS.map(({ short }, index) => (
                            <Chip
                                key={short.i18nKey}
                                label={t(short.i18nKey, short.en)}
                                selected={schedule.weekday === index}
                                onPress={() => update((s) => ({ ...s, weekday: index }))}
                            />
                        ))}
                    </ScrollView>
                </View>
            ) : null}

            {schedule.kind === 'monthly' ? (
                <Stepper
                    label={t('automations.settings.day_of_month', 'Day of the month')}
                    value={String(schedule.day)}
                    onDecrement={() => update((s) => ({ ...s, day: s.day <= 1 ? 28 : s.day - 1 }))}
                    onIncrement={() => update((s) => ({ ...s, day: s.day >= 28 ? 1 : s.day + 1 }))}
                    hint={t('mobile.automations.schedule.day_cap', 'Capped at 28 so the automation fires in February too.')}
                />
            ) : null}

            <TimeSteppers schedule={schedule} update={update} />
        </>
    );
}
