/**
 * A labelled switch row. The whole row is the touch target and carries the
 * `switch` role and checked state; the switch inside is decorative, so a
 * screen reader announces the setting once, not twice.
 */

import React, { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Switch } from './Switch';
import { Text } from './Text';

export function ToggleRow({
    label,
    description,
    value,
    onValueChange,
    disabled = false,
    /** Shown instead of the switch while a save is in flight is NOT done here:
     *  the switch stays interactive and the screen shows the failure inline. */
    icon,
    gutter = true,
    testID,
}: {
    label: string;
    description?: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    icon?: ReactNode;
    /**
     * Off for a row inside a container that already has horizontal padding —
     * a sheet's column, say. The settings screens want the gutter because
     * their rows run edge to edge inside an unpadded Group.
     */
    gutter?: boolean;
    testID?: string;
}) {
    const theme = useTheme();

    return (
        <Pressable
            testID={testID}
            // The row toggles, not just the switch — a 44px switch inside a
            // 64px row leaves most of the row dead to the touch otherwise.
            onPress={() => !disabled && onValueChange(!value)}
            disabled={disabled}
            accessibilityRole="switch"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ checked: value, disabled }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: gutter ? theme.spacing.lg : 0,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
                opacity: disabled ? 0.5 : 1,
                backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
            })}
        >
            {icon}
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{label}</Text>
                {description ? (
                    <Text variant="caption" tone="tertiary">
                        {description}
                    </Text>
                ) : null}
            </View>
            <Switch value={value} onValueChange={onValueChange} disabled={disabled} decorative />
        </Pressable>
    );
}
