/** A row that is nothing but prose — a warning, an explanation, a caveat. */

import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

export function NoteRow({ children }: { children: ReactNode }) {
    const theme = useTheme();
    return (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            {typeof children === 'string' ? (
                <Text variant="caption" tone="tertiary">
                    {children}
                </Text>
            ) : (
                children
            )}
        </View>
    );
}
