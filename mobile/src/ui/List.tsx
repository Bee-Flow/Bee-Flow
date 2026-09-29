/**
 * List rows.
 *
 * Almost every screen in Bee Flow is a list of things you can open — chats,
 * agents, automations, notebooks, transcripts. One row component means those
 * screens stay visually identical for free, and it is the single place to fix
 * touch targets, truncation and the trailing chevron.
 *
 * `leading` takes an element rather than an icon name so a row can show an
 * avatar, a status dot, a coloured square or a checkbox without this file
 * growing a union type for each.
 */

import { Feather } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


export interface ListRowProps {
    title: string;
    subtitle?: string;
    /** Right-aligned meta: a timestamp, a count, a status. */
    meta?: string;
    leading?: ReactNode;
    trailing?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    /** Shows the disclosure chevron. On by default when onPress is given. */
    chevron?: boolean;
    selected?: boolean;
    disabled?: boolean;
    /** Lets a title wrap to two lines. For content, not for settings. */
    wrapTitle?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

export function ListRow({
    title,
    subtitle,
    meta,
    leading,
    trailing,
    onPress,
    onLongPress,
    chevron,
    selected = false,
    disabled = false,
    wrapTitle = false,
    style,
    testID,
}: ListRowProps) {
    const theme = useTheme();
    const showChevron = chevron ?? (Boolean(onPress) && !trailing);

    const body = (pressed: boolean) => (
        <View
            style={[
                styles.row,
                {
                    // 52, down from 64 at the owner's request — the rows read
                    // as mostly air at 64. Still clear of the 48dp minimum
                    // touch target, so density is the only thing that changes.
                    minHeight: 52,
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.sm,
                    gap: theme.spacing.md,
                    backgroundColor: selected
                        ? theme.colors.itemActiveBg
                        : pressed
                          ? theme.colors.itemHoverBg
                          : 'transparent',
                    opacity: disabled ? 0.5 : 1,
                },
                style,
            ]}
        >
            {leading}
            <View style={styles.text}>
                {/*
                  * The title gets the two lines and the subtitle gets one, not
                  * the other way round. It was inverted, so a knowledge base
                  * called "CNC Verspaning Handleiding" rendered as
                  * "CNC Verspan…" above two full lines of its own description —
                  * the name of the thing losing to the note about the thing.
                  * A row is identified by its title; everything else on it is
                  * context for a name you can already read.
                  */}
                <Text variant="subheading" numberOfLines={wrapTitle ? 3 : 2}>
                    {title}
                </Text>
                {subtitle ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            {meta ? (
                // `flexShrink`, or "2 docs · 19 chunks" takes whatever width it
                // wants and the title pays for it. Meta is the least important
                // thing in the row and must be the first to give ground.
                <Text
                    variant="label"
                    tone="tertiary"
                    numberOfLines={1}
                    style={styles.meta}
                >
                    {meta}
                </Text>
            ) : null}
            {trailing}
            {showChevron ? (
                <Feather name="chevron-right" size={18} color={theme.colors.textMuted} />
            ) : null}
        </View>
    );

    if (!onPress && !onLongPress) return <View testID={testID}>{body(false)}</View>;

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            onLongPress={onLongPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected }}
            // The row's own text is the label; a subtitle is supporting detail
            // and reads better as a hint than as part of the name.
            accessibilityLabel={title}
            accessibilityHint={subtitle}
        >
            {({ pressed }) => body(pressed)}
        </Pressable>
    );
}

/**
 * A settings row with a value on the right — the "Language  English ›" shape.
 * Separate from ListRow because the value is not a subtitle: it is the current
 * state of a control, and it belongs on the same line as the label.
 */
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
            {onPress ? <Feather name="chevron-right" size={18} color={theme.colors.textMuted} /> : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    meta: { flexShrink: 1 },
    value: { maxWidth: '50%', textAlign: 'right' },
});
