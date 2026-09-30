/**
 * One option in a mutually exclusive set.
 *
 * A check mark rather than a filled circle: Android's Material radio is a
 * separate control that fights the row for the touch target, and a check on
 * the trailing edge is what every list-of-choices in this app already looks
 * like.
 */

import React, { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Icon } from './icons/Icon';
import { Text } from './Text';

export function OptionRow({
    label,
    description,
    selected,
    onPress,
    leading,
    disabled = false,
    testID,
}: {
    label: string;
    description?: string;
    selected: boolean;
    onPress: () => void;
    leading?: ReactNode;
    disabled?: boolean;
    testID?: string;
}) {
    const theme = useTheme();

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ selected, disabled }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
                opacity: disabled ? 0.5 : 1,
                backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
            })}
        >
            {leading}
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{label}</Text>
                {description ? (
                    <Text variant="caption" tone="tertiary">
                        {description}
                    </Text>
                ) : null}
            </View>
            {selected ? (
                <Icon name="Check" size={18} color={theme.colors.accentPrimary} />
            ) : (
                // A fixed-width spacer keeps every label on the same left edge
                // whether or not it is the selected one.
                <View style={{ width: 18 }} />
            )}
        </Pressable>
    );
}
