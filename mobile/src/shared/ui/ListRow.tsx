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

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon } from './icons/Icon';
import { Text } from './Text';

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
    const themed = useThemedStyles(makeStyles);
    const showChevron = chevron ?? (Boolean(onPress) && !trailing);

    const body = (pressed: boolean) => (
        <View
            style={[
                styles.row,
                themed.row,
                selected ? themed.selected : pressed ? themed.pressed : null,
                disabled ? themed.disabled : null,
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
                <Icon name="ChevronRight" size={18} color={theme.colors.textMuted} />
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

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    meta: { flexShrink: 1 },
});

const makeStyles = (theme: Theme) => ({
    row: {
        // 52, down from 64 at the owner's request — the rows read as mostly
        // air at 64. Still clear of the 48dp minimum touch target, so density
        // is the only thing that changes.
        minHeight: 52,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
        gap: theme.spacing.md,
    } satisfies ViewStyle,
    selected: { backgroundColor: theme.colors.itemActiveBg } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.5 } satisfies ViewStyle,
});
