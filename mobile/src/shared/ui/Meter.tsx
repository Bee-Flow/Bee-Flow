/**
 * A horizontal meter against a cap.
 *
 * `fraction` is null when there is no cap, and that is NOT the same as zero:
 * an uncapped plan gets a flat rule and the words "no limit", never an empty
 * bar that implies a limit exists and has not been touched.
 */


import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

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
