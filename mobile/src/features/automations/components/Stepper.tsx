/**
 * A +/− pair around a value. Used instead of a wheel because a 48dp button is
 * reliable with a thumb and a 40px-tall wheel is not, and because there is no
 * date/time picker in this app's fixed dependency set.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { gap: theme.spacing.xs },
        control: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgCard,
        },
    });

export function Stepper({
    label,
    value,
    hint,
    onDecrement,
    onIncrement,
    style,
}: {
    label: string;
    value: string;
    hint?: string;
    onDecrement: () => void;
    onIncrement: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={[styles.root, style]}>
            <Text variant="caption" tone="secondary" weight="medium">
                {label}
            </Text>
            <View
                accessibilityRole="adjustable"
                accessibilityLabel={label}
                accessibilityValue={{ text: value }}
                style={styles.control}
            >
                <IconButton
                    icon={<Icon name="Minus" size={18} color={theme.colors.textPrimary} />}
                    accessibilityLabel={`Decrease ${label.toLowerCase()}`}
                    onPress={onDecrement}
                />
                <Text variant="heading">{value}</Text>
                <IconButton
                    icon={<Icon name="Plus" size={18} color={theme.colors.textPrimary} />}
                    accessibilityLabel={`Increase ${label.toLowerCase()}`}
                    onPress={onIncrement}
                />
            </View>
            {hint ? (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}
