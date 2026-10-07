/**
 * One Art. 50 sub-card — the web's SubCard: an edge in the verdict's colour
 * (a faint red wash when failing), the title in its ink, the detail below.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, tint, tonePair } from '@/shared/ui';

import type { SubCardWords } from '../model/ladderCards';

export function LadderSubCard({ card, testID, children }: { card: SubCardWords; testID: string; children?: ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    const ink = styles[`${card.tone}Ink`];
    return (
        <View style={[styles.card, styles[card.tone]]} testID={testID}>
            <View style={styles.head}>
                <Icon name={card.icon} size={14} color={ink.color} />
                <Text variant="caption" weight="semibold" style={[styles.title, ink]}>
                    {card.title}
                </Text>
            </View>
            <Text variant="caption" tone="secondary">
                {card.detail}
            </Text>
            {children}
        </View>
    );
}

const makeStyles = (theme: Theme) => {
    const success = tonePair(theme.colors, 'success');
    const error = tonePair(theme.colors, 'error');
    return StyleSheet.create({
        card: {
            gap: theme.spacing[1.5],
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing[2.5],
            borderRadius: theme.radii.sm,
            borderWidth: 1,
        },
        success: { borderColor: success.raw },
        error: { borderColor: error.raw, backgroundColor: tint(error.raw, 6) },
        neutral: { borderColor: theme.colors.borderDefault },
        successInk: { color: success.ink },
        errorInk: { color: error.ink },
        neutralInk: { color: theme.colors.textSecondary },
        head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
    });
};
