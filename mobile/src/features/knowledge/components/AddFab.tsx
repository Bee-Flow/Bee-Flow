/**
 * The round "+" in the bottom corner of a list screen. Knowledge bases use it,
 * and notebooks and skills borrow it through the index; being kit-wide, it
 * is a candidate for shared/ui.
 */

import React from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fab: {
            position: 'absolute',
            right: theme.spacing.lg,
            bottom: theme.spacing.xl,
            width: 56,
            height: 56,
            borderRadius: 28,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accentPrimary,
            ...theme.elevation.raised,
        },
    });

export function AddFab({ label, onPress }: { label: string; onPress: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.fab}>
            <Icon name="Plus" size={24} color={theme.colors.accentPrimaryFg} />
        </Pressable>
    );
}
