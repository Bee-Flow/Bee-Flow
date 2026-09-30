/**
 * A row of key figures: each a card with the number large in the brand
 * violet (or the colour the model gave it) over an upper-case label. The web
 * sets up to four across; a phone wraps them two to a row.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import type { ResearchStat } from './researchModel';
import { BRAND_GRADIENT, firstColor } from '../rich/richPalette';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[3] },
        card: {
            flexGrow: 1,
            flexBasis: '40%',
            alignItems: 'center',
            paddingVertical: theme.spacing[4],
            paddingHorizontal: theme.spacing[3],
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgTertiary,
            gap: theme.spacing[1],
        },
        value: { fontSize: 22, lineHeight: 27, fontWeight: '800' },
        label: { textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
    }),
);

function figure(color: string) {
    return { color: firstColor(color) ?? BRAND_GRADIENT[0] };
}

export function ResearchStats({ items }: { items: ResearchStat[] }) {
    const styles = useThemedStyles(sheet);
    return (
        <View style={styles.grid}>
            {items.map((stat, i) => (
                <View key={i} style={styles.card}>
                    <Text style={[styles.value, figure(stat.color)]}>{stat.value}</Text>
                    <Text variant="label" tone="tertiary" style={styles.label}>
                        {stat.label}
                    </Text>
                </View>
            ))}
        </View>
    );
}
