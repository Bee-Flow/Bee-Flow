/** The floating "+" that creates whatever the current tab lists. */

import React from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fab: {
            position: 'absolute',
            right: theme.spacing.lg,
            bottom: theme.spacing.lg,
            width: 56,
            height: 56,
            borderRadius: 28,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accentPrimary,
            ...theme.elevation.raised,
        },
        dimmed: { opacity: 0.4 },
    });

export function NewItemButton({
    label,
    disabled,
    onPress,
}: {
    label: string;
    disabled: boolean;
    onPress: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            style={[styles.fab, disabled ? styles.dimmed : null]}
        >
            <Icon name="Plus" size={24} color={theme.colors.accentPrimaryFg} />
        </Pressable>
    );
}
