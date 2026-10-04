/** The five-shape schedule editor: how often, which day, and at what time. */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

import { Stepper } from './Stepper';
import { WEEKDAY_NAMES, pad, type SimpleSchedule, type SimpleScheduleKind } from '../model/cron';

const KINDS: { value: SimpleScheduleKind; label: string }[] = [
    { value: 'hourly', label: 'Every hour' },
    { value: 'daily', label: 'Every day' },
    { value: 'weekdays', label: 'Weekdays' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
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
    return (
        <View style={styles.times}>
            {schedule.kind !== 'hourly' ? (
                <Stepper
                    label="Hour"
                    value={pad(schedule.hour)}
                    onDecrement={() => update((s) => ({ ...s, hour: (s.hour + 23) % 24 }))}
                    onIncrement={() => update((s) => ({ ...s, hour: (s.hour + 1) % 24 }))}
                    style={styles.half}
                />
            ) : null}
            <Stepper
                label={schedule.kind === 'hourly' ? 'Minutes past the hour' : 'Minute'}
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
    return (
        <>
            <View style={styles.group}>
                <Text variant="caption" tone="secondary" weight="medium">
                    How often
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                    {KINDS.map((k) => (
                        <Chip
                            key={k.value}
                            label={k.label}
                            selected={schedule.kind === k.value}
                            onPress={() => update((s) => ({ ...s, kind: k.value }))}
                        />
                    ))}
                </ScrollView>
            </View>

            {schedule.kind === 'weekly' ? (
                <View style={styles.group}>
                    <Text variant="caption" tone="secondary" weight="medium">
                        On which day
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                        {WEEKDAY_NAMES.map((name, index) => (
                            <Chip
                                key={name}
                                label={name.slice(0, 3)}
                                selected={schedule.weekday === index}
                                onPress={() => update((s) => ({ ...s, weekday: index }))}
                            />
                        ))}
                    </ScrollView>
                </View>
            ) : null}

            {schedule.kind === 'monthly' ? (
                <Stepper
                    label="Day of the month"
                    value={String(schedule.day)}
                    onDecrement={() => update((s) => ({ ...s, day: s.day <= 1 ? 28 : s.day - 1 }))}
                    onIncrement={() => update((s) => ({ ...s, day: s.day >= 28 ? 1 : s.day + 1 }))}
                    hint="Capped at 28 so the automation fires in February too."
                />
            ) : null}

            <TimeSteppers schedule={schedule} update={update} />
        </>
    );
}
