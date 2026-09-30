/**
 * "When should this happen?"
 *
 * Tasks and reminders both need a moment in time, and the dependency set for
 * this app has no date/time picker — no @react-native-community/datetimepicker,
 * no expo equivalent. Rather than ask for one, this is built from the four
 * answers people actually give (in an hour, tonight, tomorrow morning, next
 * week) plus steppers for everything else. On a phone that is faster than a
 * calendar grid anyway: a reminder is almost never for the 14th of next month.
 *
 * The value is always a real Date, and the caller sends `.toISOString()` —
 * both `nextRunAt` (aiTasks) and `remindAt` (reminders) are timestamptz
 * columns, so a local wall-clock string would land in the wrong hour for
 * anyone outside the server's zone.
 */

import React from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { absoluteTime, pad } from '@/features/automations';
import { Chip, Icon, IconButton, Text } from '@/shared/ui';

interface Preset {
    label: string;
    build: () => Date;
}

const PRESETS: Preset[] = [
    { label: 'In an hour', build: () => addMinutes(new Date(), 60) },
    { label: 'This evening', build: () => atTime(new Date(), 18, 0, true) },
    { label: 'Tomorrow 09:00', build: () => atTime(addDays(new Date(), 1), 9, 0, false) },
    { label: 'Next week', build: () => atTime(addDays(new Date(), 7), 9, 0, false) },
];

export function WhenPicker({
    value,
    onChange,
    label = 'When',
}: {
    value: Date;
    onChange: (next: Date) => void;
    label?: string;
}) {
    const theme = useTheme();
    const iso = value.toISOString();
    const inPast = isPast(value);

    const shift = (fn: (d: Date) => Date) => onChange(fn(new Date(value.getTime())));

    return (
        <View style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="secondary" weight="medium">
                {label}
            </Text>

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
            >
                {PRESETS.map((preset) => (
                    <Chip key={preset.label} label={preset.label} onPress={() => onChange(preset.build())} />
                ))}
            </ScrollView>

            <View
                accessibilityLiveRegion="polite"
                style={{
                    padding: theme.spacing.md,
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.bgTertiary,
                    gap: 2,
                }}
            >
                <Text variant="subheading">{absoluteTime(iso)}</Text>
                <Text variant="caption" tone={inPast ? 'warning' : 'tertiary'}>
                    {inPast
                        ? 'That moment has passed — it will fire on the next scheduler tick.'
                        : value.toLocaleDateString(undefined, {
                              weekday: 'long',
                              day: 'numeric',
                              month: 'long',
                          })}
                </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                <Adjuster
                    label="Day"
                    value={value.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    onDown={() => shift((d) => addDays(d, -1))}
                    onUp={() => shift((d) => addDays(d, 1))}
                />
                <Adjuster
                    label="Hour"
                    value={pad(value.getHours())}
                    onDown={() => shift((d) => addMinutes(d, -60))}
                    onUp={() => shift((d) => addMinutes(d, 60))}
                />
                <Adjuster
                    label="Minute"
                    value={pad(value.getMinutes())}
                    onDown={() => shift((d) => addMinutes(d, -5))}
                    onUp={() => shift((d) => addMinutes(d, 5))}
                />
            </View>
        </View>
    );
}

function Adjuster({
    label,
    value,
    onDown,
    onUp,
}: {
    label: string;
    value: string;
    onDown: () => void;
    onUp: () => void;
}) {
    const theme = useTheme();
    return (
        <View
            accessibilityRole="adjustable"
            accessibilityLabel={label}
            accessibilityValue={{ text: value }}
            style={{
                flex: 1,
                alignItems: 'center',
                gap: theme.spacing.xs,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.bgCard,
            }}
        >
            <IconButton
                icon={<Icon name="ChevronUp" size={18} color={theme.colors.textPrimary} />}
                accessibilityLabel={`Later ${label.toLowerCase()}`}
                onPress={onUp}
            />
            <Text variant="subheading">{value}</Text>
            <Text variant="label" tone="tertiary">
                {label.toUpperCase()}
            </Text>
            <IconButton
                icon={<Icon name="ChevronDown" size={18} color={theme.colors.textPrimary} />}
                accessibilityLabel={`Earlier ${label.toLowerCase()}`}
                onPress={onDown}
            />
        </View>
    );
}

/**
 * Module-level so the clock is read outside the render pass. A component body
 * that calls Date.now() directly is impure — it produces a different result on
 * every re-render, which is exactly what React's purity rules forbid.
 */
function isPast(date: Date): boolean {
    return date.getTime() < Date.now();
}

function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
}

/** Set a wall-clock time, optionally rolling to tomorrow if it already passed. */
function atTime(date: Date, hour: number, minute: number, rollForward: boolean): Date {
    const next = new Date(date.getTime());
    next.setHours(hour, minute, 0, 0);
    if (rollForward && next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    return next;
}
