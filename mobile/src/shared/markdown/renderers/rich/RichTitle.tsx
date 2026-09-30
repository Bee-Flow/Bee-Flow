/**
 * A report's or a section's title over the brand gradient underline — the
 * web's h1 (1.5rem, 800) and h2 (1.25rem, 700) with `border-image`.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { GradientRule } from './GradientRule';
import { BRAND_GRADIENT } from './richPalette';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        wrap: { gap: theme.spacing[2] },
        report: { fontSize: 21, lineHeight: 27, ...theme.fonts.bold },
        section: { fontSize: 18, lineHeight: 24, ...theme.fonts.bold },
    }),
);

export function RichTitle({ text, level }: { text: string; level: 'report' | 'section' }) {
    const styles = useThemedStyles(sheet);
    return (
        <View style={styles.wrap}>
            <Text accessibilityRole="header" style={level === 'report' ? styles.report : styles.section}>
                {text}
            </Text>
            <GradientRule colors={BRAND_GRADIENT} />
        </View>
    );
}
