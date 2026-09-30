/**
 * A bar chart of a value per period, drawn by hand in react-native-svg.
 *
 * No charting library is installed and none is going to be: what this app
 * plots is a column of bars over a time axis, and a library would add roughly a
 * megabyte to a direct-download APK to draw thirty rectangles. Non-interactive
 * on purpose — a phone has no hover — so the chart carries a summary label and
 * a screen reader gets the trend as a sentence.
 */

import React from 'react';
import { View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

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
