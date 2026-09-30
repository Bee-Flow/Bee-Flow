/**
 * A read-only fact: label on the left, value on the right.
 *
 * Not SettingRow, which is a button and renders a chevron. A version number or
 * a licence tier is not a place you can go, and giving it a chevron is a lie
 * the user only discovers by tapping.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

export function InfoRow({
    label,
    value,
    tone = 'tertiary',
    selectable = false,
}: {
    label: string;
    value: string;
    tone?: 'tertiary' | 'success' | 'warning' | 'error' | 'primary';
    /** Turn on for values a person will want to copy into a bug report. */
    selectable?: boolean;
}) {
    const theme = useTheme();
    return (
        <View
            accessible
            accessibilityLabel={`${label}: ${value}`}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
            }}
        >
            <Text variant="body" style={{ flex: 1 }}>
                {label}
            </Text>
            <Text
                variant="body"
                tone={tone}
                selectable={selectable}
                numberOfLines={2}
                style={{ flexShrink: 1, maxWidth: '60%', textAlign: 'right' }}
            >
                {value}
            </Text>
        </View>
    );
}
