/**
 * A checkbox with its sentence — a deliberate "yes, I did this", such as the
 * tick that a one-time secret was saved before it can be left behind. The
 * whole row is the target; the box fills with the accent when ticked.
 */

import * as Haptics from 'expo-haptics';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon } from './icons/Icon';
import { Text } from './Text';

export function CheckRow({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable
            onPress={() => {
                void Haptics.selectionAsync();
                onToggle();
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel={label}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
            <View style={[styles.box, checked && styles.checked]}>
                {checked ? <Icon name="Check" size={14} color={theme.colors.accentPrimaryFg} /> : null}
            </View>
            <Text variant="body" style={styles.label}>
                {label}
            </Text>
        </Pressable>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            minHeight: theme.minTouch,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radii.md,
        },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        box: {
            width: 22,
            height: 22,
            borderRadius: theme.radii.sm,
            borderWidth: 2,
            borderColor: theme.colors.borderDefault,
            alignItems: 'center',
            justifyContent: 'center',
        },
        checked: { borderColor: theme.colors.accentPrimary, backgroundColor: theme.colors.accentPrimary },
        label: { flex: 1 },
    });
