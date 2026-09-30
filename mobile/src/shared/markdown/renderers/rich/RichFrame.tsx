/**
 * The card a research report, a test report or a page sits in — the web's
 * outer box for all three: the primary background, a subtle border and a
 * 1rem radius, set apart from the answer's own text.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        frame: {
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgPrimary,
            overflow: 'hidden',
        },
        padded: { padding: theme.spacing[4], gap: theme.spacing[4] },
    }),
);

export function RichFrame({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
    const styles = useThemedStyles(sheet);
    return <View style={[styles.frame, padded && styles.padded]}>{children}</View>;
}
