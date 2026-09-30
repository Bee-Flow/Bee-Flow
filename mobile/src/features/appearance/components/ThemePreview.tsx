/**
 * A live miniature of a theme.
 *
 * A row of coloured dots does not tell anyone what a theme is like to use —
 * the thing people actually judge is contrast between a surface and the text
 * on it, and how loud the accent is next to both. So this draws a real (tiny)
 * Bee Flow screen: a title bar, a card with two lines of text, an assistant
 * bubble and an accent button, painted from that theme's own palette rather
 * than from the one currently in force.
 *
 * The miniature deliberately does NOT go through <Text> or the themed styles:
 * every colour inside it comes from the previewed palette, so only the layout
 * is shared (`mini` below) and the colours are applied per tile.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { PALETTES, type DayNight } from '@/core/theme/tokens';
import { Icon, Text } from '@/shared/ui';

export function ThemePreview({
    name,
    label,
    description,
    selected,
    onPress,
    /** Accent from org branding, when the admin pinned one. */
    accentOverride,
}: {
    name: DayNight;
    label: string;
    description: string;
    selected: boolean;
    onPress: () => void;
    accentOverride?: string | null;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const palette = PALETTES[name];
    const accent = accentOverride ?? palette.accentPrimary;


    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ selected }}
            style={({ pressed }) => [
                styles.tile,
                selected ? styles.selected : null,
                pressed ? styles.pressed : null,
            ]}
        >
            <View
                // Decorative: the label below carries the name, and a screen
                // reader announcing "rectangle, rectangle, rectangle" helps
                // nobody.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[mini.screen, { backgroundColor: palette.bgPrimary }]}
            >
                {/* Title bar */}
                <View style={mini.row}>
                    <View style={[mini.dot, { backgroundColor: accent }]} />
                    <View style={[mini.title, { backgroundColor: palette.textPrimary }]} />
                </View>

                {/* A card with two lines */}
                <View
                    style={[
                        mini.card,
                        { backgroundColor: palette.bgCard, borderColor: palette.borderSubtle },
                    ]}
                >
                    <View style={[mini.line, mini.long, { backgroundColor: palette.textPrimary }]} />
                    <View style={[mini.line, mini.short, { backgroundColor: palette.textMuted }]} />
                </View>

                {/* The user's own bubble, then the accent button */}
                <View style={mini.composer}>
                    <View style={[mini.bubble, { backgroundColor: palette.userBubbleBg }]} />
                    <View style={[mini.send, { backgroundColor: accent }]}>
                        <Icon name="ArrowUp" size={10} color={palette.accentPrimaryFg} />
                    </View>
                </View>
            </View>

            <View style={styles.caption}>
                <View style={mini.row}>
                    <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.label}>
                        {label}
                    </Text>
                    {selected ? (
                        <Icon name="Check" size={13} color={theme.colors.accentPrimary} />
                    ) : null}
                </View>
                <Text variant="label" tone="tertiary" numberOfLines={1}>
                    {description}
                </Text>
            </View>
        </Pressable>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tile: {
            flex: 1,
            borderRadius: theme.radii.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderDefault,
            overflow: 'hidden',
            backgroundColor: theme.colors.bgCard,
        },
        selected: { borderWidth: 2, borderColor: theme.colors.accentPrimary },
        pressed: { opacity: 0.85 },
        caption: { padding: theme.spacing.sm, gap: 1 },
        label: { flex: 1 },
    });

/** The miniature's layout, in fixed pixels: it is a drawing, not a screen. */
const mini = StyleSheet.create({
    screen: { height: 96, padding: 8, gap: 6 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    title: { height: 5, width: 34, borderRadius: 3 },
    card: { borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, padding: 6, gap: 4 },
    line: { height: 4, borderRadius: 2 },
    long: { width: '70%' },
    short: { width: '45%' },
    composer: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    bubble: { flex: 1, height: 16, borderRadius: 8 },
    send: {
        width: 26,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
