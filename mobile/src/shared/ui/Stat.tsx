/** A big number with its unit, for the row of headline figures. */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

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
