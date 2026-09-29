/**
 * The schedule a phone is allowed to change.
 *
 * The desktop builder writes any 5-field cron. This offers five shapes and
 * refuses to touch anything else — a cron field editor at thumb size is a way
 * to break a live routine by accident, and "every 15 minutes on weekdays in
 * Q4" is not a thing anyone should be editing on a train.
 *
 * The preview under the picker is NOT computed here. It comes from
 * POST /api/automation/_schedule/preview, which runs the same
 * `cron.nextRunAt` the scheduler itself uses — so the three times shown are
 * the three times that will actually happen, including the timezone's own
 * daylight-saving oddities, rather than a plausible-looking phone-side guess.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Chip } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { Banner, Spinner } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';
import { previewSchedule } from '../api';
import {
    DEFAULT_SIMPLE_SCHEDULE,
    WEEKDAY_NAMES,
    absoluteTime,
    cronFromSimple,
    describeCron,
    pad,
    simpleFromCron,
    type SimpleSchedule,
    type SimpleScheduleKind,
} from '../format';

const KINDS: { value: SimpleScheduleKind; label: string }[] = [
    { value: 'hourly', label: 'Every hour' },
    { value: 'daily', label: 'Every day' },
    { value: 'weekdays', label: 'Weekdays' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
];

export function SchedulePicker({
    cron,
    tz,
    saving,
    onSave,
}: {
    cron: string | null;
    tz: string;
    saving: boolean;
    onSave: (cron: string) => void;
}) {
    const theme = useTheme();
    const parsed = simpleFromCron(cron);
    /** A pattern the picker cannot represent stays untouched until asked. */
    const [replacingCustom, setReplacingCustom] = useState(false);
    const [schedule, setSchedule] = useState<SimpleSchedule>(parsed ?? DEFAULT_SIMPLE_SCHEDULE);

    // A different routine's schedule can arrive while this sheet is mounted, and
    // a save rewrites the one it already shows. Reset during render rather than
    // in an effect: an effect would leave the old times on screen for a frame.
    const [lastCron, setLastCron] = useState(cron);
    if (lastCron !== cron) {
        setLastCron(cron);
        setSchedule(parsed ?? DEFAULT_SIMPLE_SCHEDULE);
        setReplacingCustom(false);
    }

    const nextCron = cronFromSimple(schedule);

    const preview = useQuery({
        queryKey: ['automate', 'schedule-preview', nextCron, tz],
        queryFn: () => previewSchedule(nextCron, tz, 3),
        // Cheap on the server but rate-limited with the run endpoints, so it is
        // not worth re-asking for a cron we already resolved this session.
        staleTime: 5 * 60_000,
        retry: false,
    });

    if (cron && !parsed && !replacingCustom) {
        return (
            <View style={{ gap: theme.spacing.lg }}>
                <Banner tone="info" icon="monitor">
                    This routine runs on a custom pattern. The phone can show it, but changing it
                    safely needs the schedule editor on the desktop.
                </Banner>
                <View
                    style={{
                        padding: theme.spacing.md,
                        borderRadius: theme.radii.md,
                        backgroundColor: theme.colors.bgTertiary,
                    }}
                >
                    <Text variant="code" selectable>
                        {cron}
                    </Text>
                </View>
                <Text variant="caption" tone="tertiary">
                    {describeCron(cron, tz)}
                </Text>
                <Button
                    label="Replace with a simple schedule"
                    variant="secondary"
                    onPress={() => setReplacingCustom(true)}
                    accessibilityHint="Discards the custom pattern and picks a daily, weekly or monthly time instead"
                />
            </View>
        );
    }

    return (
        <View style={{ gap: theme.spacing.lg }}>
            {replacingCustom ? (
                <Banner tone="warning">
                    Saving replaces the custom pattern. The old expression is not kept.
                </Banner>
            ) : null}

            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="secondary" weight="medium">
                    How often
                </Text>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
                >
                    {KINDS.map((k) => (
                        <Chip
                            key={k.value}
                            label={k.label}
                            selected={schedule.kind === k.value}
                            onPress={() => setSchedule((s) => ({ ...s, kind: k.value }))}
                        />
                    ))}
                </ScrollView>
            </View>

            {schedule.kind === 'weekly' ? (
                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="caption" tone="secondary" weight="medium">
                        On which day
                    </Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
                    >
                        {WEEKDAY_NAMES.map((name, index) => (
                            <Chip
                                key={name}
                                label={name.slice(0, 3)}
                                selected={schedule.weekday === index}
                                onPress={() => setSchedule((s) => ({ ...s, weekday: index }))}
                            />
                        ))}
                    </ScrollView>
                </View>
            ) : null}

            {schedule.kind === 'monthly' ? (
                <Stepper
                    label="Day of the month"
                    value={String(schedule.day)}
                    onDecrement={() =>
                        setSchedule((s) => ({ ...s, day: s.day <= 1 ? 28 : s.day - 1 }))
                    }
                    onIncrement={() =>
                        setSchedule((s) => ({ ...s, day: s.day >= 28 ? 1 : s.day + 1 }))
                    }
                    hint="Capped at 28 so the routine fires in February too."
                />
            ) : null}

            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                {schedule.kind !== 'hourly' ? (
                    <Stepper
                        label="Hour"
                        value={pad(schedule.hour)}
                        onDecrement={() =>
                            setSchedule((s) => ({ ...s, hour: (s.hour + 23) % 24 }))
                        }
                        onIncrement={() => setSchedule((s) => ({ ...s, hour: (s.hour + 1) % 24 }))}
                        style={{ flex: 1 }}
                    />
                ) : null}
                <Stepper
                    label={schedule.kind === 'hourly' ? 'Minutes past the hour' : 'Minute'}
                    value={pad(schedule.minute)}
                    onDecrement={() =>
                        setSchedule((s) => ({ ...s, minute: (s.minute + 55) % 60 }))
                    }
                    onIncrement={() => setSchedule((s) => ({ ...s, minute: (s.minute + 5) % 60 }))}
                    style={{ flex: 1 }}
                />
            </View>

            <View
                accessibilityLiveRegion="polite"
                style={{
                    gap: theme.spacing.xs,
                    padding: theme.spacing.md,
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.bgTertiary,
                }}
            >
                <Text variant="caption" weight="medium">
                    {describeCron(nextCron, tz)}
                </Text>
                {preview.isFetching ? (
                    <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center' }}>
                        <Spinner />
                        <Text variant="caption" tone="tertiary">
                            Working out the next runs…
                        </Text>
                    </View>
                ) : preview.data && preview.data.valid ? (
                    preview.data.next.map((iso) => (
                        <View key={iso} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            <Feather name="chevron-right" size={14} color={theme.colors.textMuted} />
                            <Text variant="caption" tone="secondary">
                                {absoluteTime(iso)}
                            </Text>
                        </View>
                    ))
                ) : preview.data && !preview.data.valid ? (
                    <Text variant="caption" tone="error">
                        {preview.data.error ?? 'The server could not read that schedule.'}
                    </Text>
                ) : (
                    <Text variant="caption" tone="tertiary">
                        The next run times will be confirmed when you save.
                    </Text>
                )}
            </View>

            <Button
                label="Save schedule"
                onPress={() => onSave(nextCron)}
                loading={saving}
                fullWidth
                size="lg"
            />
        </View>
    );
}

/**
 * A +/− pair around a value. Used instead of a wheel because a 48dp button is
 * reliable with a thumb and a 40px-tall wheel is not, and because there is no
 * date/time picker in this app's fixed dependency set.
 */
function Stepper({
    label,
    value,
    hint,
    onDecrement,
    onIncrement,
    style,
}: {
    label: string;
    value: string;
    hint?: string;
    onDecrement: () => void;
    onIncrement: () => void;
    style?: object;
}) {
    const theme = useTheme();
    return (
        <View style={[{ gap: theme.spacing.xs }, style]}>
            <Text variant="caption" tone="secondary" weight="medium">
                {label}
            </Text>
            <View
                accessibilityRole="adjustable"
                accessibilityLabel={label}
                accessibilityValue={{ text: value }}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.bgCard,
                }}
            >
                <IconButton
                    icon={<Feather name="minus" size={18} color={theme.colors.textPrimary} />}
                    accessibilityLabel={`Decrease ${label.toLowerCase()}`}
                    onPress={onDecrement}
                />
                <Text variant="heading">{value}</Text>
                <IconButton
                    icon={<Feather name="plus" size={18} color={theme.colors.textPrimary} />}
                    accessibilityLabel={`Increase ${label.toLowerCase()}`}
                    onPress={onIncrement}
                />
            </View>
            {hint ? (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}
