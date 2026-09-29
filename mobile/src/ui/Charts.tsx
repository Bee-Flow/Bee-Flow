/**
 * Charts, drawn by hand in react-native-svg: BarChart, Meter, Stat.
 *
 * No charting library is installed and none is going to be: the whole of what
 * this app plots is a column of bars over a time axis and a horizontal meter
 * against a limit. A chart library would add roughly a megabyte to a
 * direct-download APK to draw thirty rectangles.
 *
 * All three are non-interactive on purpose. Tooltips need a hover, which a
 * phone does not have, so the numbers that matter are printed as text beside
 * the chart rather than hidden behind a tap. The chart itself is decorative and
 * each carries a summary label, so a screen reader gets the trend as a sentence
 * instead of thirty unlabelled paths.
 *
 * Promoted out of features/settings, where it was built for the usage screen
 * while src/ui was off limits. Nothing about a bar chart is a setting, and the
 * next screen that plots anything should not have to import it from there.
 */

import React from 'react';
import { View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { Text } from './Text';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';


export interface Column {
    /** X-axis label. Only the first and last are printed — the rest would
     *  collide at phone width. */
    label: string;
    value: number;
}

/**
 * A bar chart of a value per period.
 *
 * Bars rather than a line: the series is a set of discrete daily totals, and a
 * line implies a continuous quantity that was sampled — which invites reading
 * a slope between two days that had no traffic at all.
 */
export function BarChart({
    columns,
    height = 120,
    /** Rendered under the chart as "<total> over <n> days". */
    summary,
    tint,
}: {
    columns: Column[];
    height?: number;
    summary?: string;
    tint?: string;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const colour = tint ?? theme.colors.accentPrimary;

    if (columns.length === 0) {
        return (
            <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
                <Text variant="caption" tone="tertiary">
                    {t('mobile.chart.empty', 'Nothing recorded in this period.')}
                </Text>
            </View>
        );
    }

    const max = Math.max(...columns.map((c) => c.value), 0);
    // A flat-zero series still needs a baseline to draw against, or every bar
    // divides by zero and disappears.
    const scale = max > 0 ? max : 1;

    // The viewBox is in "one unit per column" space and the SVG stretches to
    // the container, so the bars stay proportional at any width without this
    // component ever measuring itself.
    const slot = 10;
    const gap = 2.4;
    const width = columns.length * slot;
    const first = columns[0];
    const last = columns[columns.length - 1];

    return (
        <View style={{ gap: theme.spacing.xs }}>
            <View
                accessible
                accessibilityLabel={summary ?? 'Usage chart'}
                accessibilityRole="image"
                style={{ height }}
            >
                <Svg
                    width="100%"
                    height={height}
                    viewBox={`0 0 ${width} 100`}
                    preserveAspectRatio="none"
                >
                    {/* Baseline — without it a run of empty days reads as a
                        missing chart rather than as zero. */}
                    <Line
                        x1={0}
                        y1={99.5}
                        x2={width}
                        y2={99.5}
                        stroke={theme.colors.borderDefault}
                        strokeWidth={0.6}
                    />
                    {columns.map((column, index) => {
                        // 1.5 units minimum so a non-zero day is never invisible
                        // next to a spike two orders of magnitude larger.
                        const barHeight =
                            column.value > 0 ? Math.max(1.5, (column.value / scale) * 92) : 0;
                        return (
                            <Rect
                                key={`${column.label}-${index}`}
                                x={index * slot + gap / 2}
                                y={99 - barHeight}
                                width={slot - gap}
                                height={barHeight}
                                rx={1.2}
                                fill={colour}
                                opacity={column.value > 0 ? 0.9 : 0.25}
                            />
                        );
                    })}
                </Svg>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="label" tone="tertiary">
                    {first?.label ?? ''}
                </Text>
                <Text variant="label" tone="tertiary">
                    {last?.label ?? ''}
                </Text>
            </View>
        </View>
    );
}

/**
 * A horizontal meter against a cap.
 *
 * `fraction` is null when there is no cap, and that is NOT the same as zero:
 * an uncapped plan gets a flat rule and the words "no limit", never an empty
 * bar that implies a limit exists and has not been touched.
 */
export function Meter({
    label,
    valueLabel,
    fraction,
    capLabel,
}: {
    label: string;
    valueLabel: string;
    fraction: number | null;
    /** e.g. "of €50.00" — omitted when there is no cap. */
    capLabel?: string;
}) {
    const theme = useTheme();

    // Warn before the wall, not at it. 90% is where someone can still do
    // something about it; 100% is where the 402s start.
    const tint =
        fraction === null
            ? theme.colors.textMuted
            : fraction >= 1
              ? theme.colors.error
              : fraction >= 0.9
                ? theme.colors.warning
                : theme.colors.accentPrimary;

    return (
        <View
            accessible
            accessibilityLabel={
                fraction === null
                    ? `${label}: ${valueLabel}, no limit`
                    : `${label}: ${valueLabel} ${capLabel ?? ''}, ${Math.round(fraction * 100)} per cent used`
            }
            style={{ gap: theme.spacing.xs }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
                <Text variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
                    {label}
                </Text>
                <Text variant="caption" weight="semibold">
                    {valueLabel}
                </Text>
                {capLabel ? (
                    <Text variant="caption" tone="tertiary">
                        {capLabel}
                    </Text>
                ) : null}
            </View>
            <View
                style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: theme.colors.bgTertiary,
                    overflow: 'hidden',
                }}
            >
                <View
                    style={{
                        height: 6,
                        borderRadius: 3,
                        width: fraction === null ? '100%' : `${Math.max(2, fraction * 100)}%`,
                        backgroundColor: tint,
                        opacity: fraction === null ? 0.25 : 1,
                    }}
                />
            </View>
        </View>
    );
}

/** A big number with its unit, for the row of headline figures. */
export function Stat({
    label,
    value,
    caption,
    tone = 'primary',
}: {
    label: string;
    value: string;
    caption?: string;
    tone?: 'primary' | 'accent' | 'warning';
}) {
    const theme = useTheme();
    return (
        <View
            accessible
            accessibilityLabel={`${label}: ${value}${caption ? `, ${caption}` : ''}`}
            style={{ flex: 1, gap: 2, paddingVertical: theme.spacing.sm }}
        >
            <Text variant="label" tone="tertiary" numberOfLines={1}>
                {label.toUpperCase()}
            </Text>
            <Text variant="heading" tone={tone} numberOfLines={1}>
                {value}
            </Text>
            {caption ? (
                <Text variant="label" tone="tertiary" numberOfLines={1}>
                    {caption}
                </Text>
            ) : null}
        </View>
    );
}
