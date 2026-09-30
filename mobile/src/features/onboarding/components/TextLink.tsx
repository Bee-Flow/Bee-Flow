import React from 'react';
import { Pressable } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

/**
 * A quiet, full-width text action — "Forgot your password?", "Use a recovery
 * code", "Sign out". A Button with variant="ghost" is the same thing, but
 * these read as prose rather than as controls, and stacking four ghost buttons
 * makes a screen look like a keypad.
 */
export function TextLink({
    label,
    onPress,
    tone = 'accent',
    disabled = false,
    accessibilityHint,
}: {
    label: string;
    onPress: () => void;
    tone?: 'accent' | 'tertiary' | 'error';
    disabled?: boolean;
    accessibilityHint?: string;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => ({
                // Full 48dp of touch, without 48dp of visible whitespace.
                minHeight: theme.minTouch,
                justifyContent: 'center',
                borderRadius: theme.radii.md,
                opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
            })}
        >
            <Text
                variant="body"
                tone={tone === 'accent' ? 'accent' : tone === 'error' ? 'error' : 'tertiary'}
                center
                weight="medium"
            >
                {label}
            </Text>
        </Pressable>
    );
}
