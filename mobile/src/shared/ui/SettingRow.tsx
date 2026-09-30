/**
 * A settings row with a value on the right — the "Language  English ›" shape.
 * Separate from ListRow because the value is not a subtitle: it is the current
 * state of a control, and it belongs on the same line as the label.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Icon } from './icons/Icon';
import { Text } from './Text';

export function SettingRow({
    label,
    value,
    onPress,
    icon,
    destructive = false,
    disabled = false,
    testID,
}: {
    label: string;
    value?: string;
    onPress?: () => void;
    icon?: ReactNode;
    destructive?: boolean;
    disabled?: boolean;
    testID?: string;
}) {
    const theme = useTheme();
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled || !onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityValue={value ? { text: value } : undefined}
            style={({ pressed }) => [
                styles.row,
                {
                    minHeight: theme.minTouch,
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    gap: theme.spacing.md,
                    backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
                    opacity: disabled ? 0.5 : 1,
                },
            ]}
        >
            {icon}
            <Text variant="body" tone={destructive ? 'error' : 'primary'} style={styles.text}>
                {label}
            </Text>
            {value ? (
                <Text variant="body" tone="tertiary" numberOfLines={1} style={styles.value}>
                    {value}
                </Text>
            ) : null}
            {onPress ? <Icon name="ChevronRight" size={18} color={theme.colors.textMuted} /> : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    value: { maxWidth: '50%', textAlign: 'right' },
});
