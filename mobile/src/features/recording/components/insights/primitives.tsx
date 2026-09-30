/**
 * The Insights tabs' building blocks, so five tabs read as one system — the
 * phone's form of agent-hub's detail/insights/primitives.jsx: a headline
 * tile, a label → value row (a seek button when it has a moment), a heading,
 * a proportion bar, a turn-taking sparkline and the stacked airtime chart.
 *
 * Every bar and column is sized from data, so their sizes come from small
 * functions below rather than style objects written into the JSX.
 */

import React, { type ReactNode } from 'react';
import { Pressable, View, type DimensionValue, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatDuration } from '@/features/recording/model/format';
import { Text } from '@/shared/ui';


const percent = (fraction: number, floor = 1): DimensionValue =>
    `${Math.max(floor, Math.round((Number(fraction) || 0) * 100))}%`;

const barFill = (fraction: number, colour: string): ViewStyle => ({ width: percent(fraction), backgroundColor: colour });
const columnFill = (fraction: number, colour: string, opacity = 1): ViewStyle => ({
    height: percent(fraction, 2),
    backgroundColor: colour,
    opacity,
});

/** "4:47" for seconds, a dash for nothing. */
export function durationOrDash(seconds: number | null | undefined): string {
    return seconds !== null && seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds) : '—';
}

/** One of the three headline numbers. */
export function StatTile({ label, value, hint }: { label: string; value: string; hint: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.tile} accessible accessibilityLabel={`${label}, ${value}`} accessibilityHint={hint}>
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {label}
            </Text>
            <Text variant="subheading" weight="semibold" style={styles.tabular}>
                {value}
            </Text>
        </View>
    );
}

export function TabHeading({ children }: { children: string }) {
    return (
        <Text variant="label" weight="semibold" accessibilityRole="header">
            {children}
        </Text>
    );
}

/** What a tab says when it has nothing to show — never a bare heading. */
export function EmptyNote({ children }: { children: string }) {
    return (
        <Text variant="caption" tone="tertiary">
            {children}
        </Text>
    );
}

export interface MetricRowProps {
    label: string;
    value: string | number;
    detail?: string;
    flagged?: boolean;
    /** Makes the row a button that jumps the recording to its moment. */
    onPress?: () => void;
    hint?: string;
}

export function MetricRow({ label, value, detail, flagged = false, onPress, hint }: MetricRowProps) {
    const styles = useThemedStyles(makeStyles);
    const body = (
        <>
            <Text variant="caption" tone="secondary" numberOfLines={2} style={styles.flex}>
                {label}
            </Text>
            {detail ? (
                <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.detail}>
                    {detail}
                </Text>
            ) : null}
            <Text variant="caption" weight="medium" tone={flagged ? 'warning' : onPress ? 'accent' : 'primary'} style={styles.tabular}>
                {String(value)}
            </Text>
        </>
    );
    if (!onPress) return <View style={styles.metric}>{body}</View>;
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityHint={hint}
            style={({ pressed }) => [styles.metric, pressed ? styles.pressed : null]}
        >
            {body}
        </Pressable>
    );
}

/** One row of a ranked list: label, proportion bar, value. */
export function BarRow({ label, fraction, value, colour, onPress, hint }: {
    label: string;
    fraction: number;
    value: string;
    colour?: string;
    onPress?: () => void;
    hint?: string;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable
            disabled={!onPress}
            onPress={onPress}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityLabel={`${label}, ${value}`}
            accessibilityHint={hint}
            style={styles.barRow}
        >
            <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.barLabel}>
                {label}
            </Text>
            <View style={styles.track}>
                <View style={[styles.fill, barFill(fraction, colour ?? theme.colors.accentPrimary)]} />
            </View>
            <Text variant="caption" tone="tertiary" style={styles.tabular}>
                {value}
            </Text>
        </Pressable>
    );
}

/** Speaker changes per window: tall is a lively exchange. Each column seeks. */
export function Sparkline({ points, label, onSeek }: {
    points: readonly { start: number; value: number }[];
    label: string;
    onSeek?: (seconds: number) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const max = points.reduce((m, p) => Math.max(m, p.value), 0);
    return (
        <View style={styles.spark} accessibilityRole="image" accessibilityLabel={label}>
            {points.map((p) => (
                <Pressable key={p.start} disabled={!onSeek} onPress={() => onSeek?.(p.start)} style={styles.column}>
                    <View
                        style={[
                            styles.columnFill,
                            columnFill(max > 0 ? p.value / max : 0, theme.colors.accentPrimary, max > 0 && p.value > 0 ? 0.85 : 0.25),
                        ]}
                    />
                </Pressable>
            ))}
        </View>
    );
}

/** Who held the floor in each window: one stacked column per window. */
export function StackedAirtime({ windows, colourFor, label, onSeek }: {
    windows: readonly { start: number; shares: readonly { speakerId: string; share: number }[] }[];
    colourFor: (speakerId: string) => string;
    label: string;
    onSeek?: (seconds: number) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.airtime} accessibilityRole="image" accessibilityLabel={label}>
            {windows.map((w) => (
                <Pressable key={w.start} disabled={!onSeek} onPress={() => onSeek?.(w.start)} style={styles.stack}>
                    {w.shares.map((s) => (
                        <View key={s.speakerId} style={columnFill(s.share, colourFor(s.speakerId))} />
                    ))}
                </Pressable>
            ))}
        </View>
    );
}

/** A tab's body: its blocks spaced as one column. */
export function TabBody({ children }: { children: ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    return <View style={styles.body}>{children}</View>;
}

/** One block inside a tab: a heading and its rows. */
export function Block({ children }: { children: ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    return <View style={styles.block}>{children}</View>;
}

const makeStyles = (theme: Theme) => ({
    tile: {
        flex: 1,
        gap: 2,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    tabular: { fontVariant: ['tabular-nums' as const] },
    flex: { flex: 1 },
    detail: { maxWidth: '45%' as const },
    metric: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.spacing.sm,
        minHeight: 32,
        paddingVertical: theme.spacing.xs,
    } satisfies ViewStyle,
    pressed: { opacity: 0.6 } satisfies ViewStyle,
    barRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, minHeight: 32 } satisfies ViewStyle,
    barLabel: { width: 112 },
    track: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    fill: { height: '100%', borderRadius: 4 } satisfies ViewStyle,
    spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, height: 40 } satisfies ViewStyle,
    column: { flex: 1, height: '100%', justifyContent: 'flex-end' } satisfies ViewStyle,
    columnFill: { borderRadius: 2 } satisfies ViewStyle,
    airtime: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, height: 64 } satisfies ViewStyle,
    stack: {
        flex: 1,
        height: '100%',
        justifyContent: 'flex-end',
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    body: { gap: theme.spacing.lg } satisfies ViewStyle,
    block: { gap: theme.spacing.xs } satisfies ViewStyle,
});
