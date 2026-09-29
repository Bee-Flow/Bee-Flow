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
 * It deliberately does NOT go through <Text>: every colour here comes from the
 * previewed palette, not the active one, so the usual themed components would
 * paint it in the wrong theme.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { PALETTES, type ThemeName } from '../../../theme/tokens';
import { Text } from '../../../ui/Text';

export function ThemePreview({
    name,
    label,
    description,
    selected,
    onPress,
    /** Accent from org branding, when the admin pinned one. */
    accentOverride,
}: {
    name: ThemeName;
    label: string;
    description: string;
    selected: boolean;
    onPress: () => void;
    accentOverride?: string | null;
}) {
    const theme = useTheme();
    const palette = PALETTES[name];
    const accent = accentOverride ?? palette.accentPrimary;

    // A glass theme's bgPrimary is literally `transparent` — there is a
    // wallpaper layer behind it in the real app. The swatch paints its
    // backdrop instead, which is the same colour that layer resolves to.
    const ground = palette.bgPrimary === 'transparent' ? palette.glassBackdrop : palette.bgPrimary;

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ selected }}
            style={({ pressed }) => [
                {
                    flex: 1,
                    borderRadius: theme.radii.lg,
                    borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                    borderColor: selected ? theme.colors.accentPrimary : theme.colors.borderDefault,
                    overflow: 'hidden',
                    opacity: pressed ? 0.85 : 1,
                    backgroundColor: theme.colors.bgCard,
                },
            ]}
        >
            <View
                // Decorative: the label below carries the name, and a screen
                // reader announcing "rectangle, rectangle, rectangle" helps
                // nobody.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ height: 96, backgroundColor: ground, padding: 8, gap: 6 }}
            >
                {/* Title bar */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: accent,
                        }}
                    />
                    <View
                        style={{
                            height: 5,
                            width: 34,
                            borderRadius: 3,
                            backgroundColor: palette.textPrimary,
                        }}
                    />
                </View>

                {/* A card with two lines */}
                <View
                    style={{
                        backgroundColor: palette.bgCard,
                        borderRadius: 6,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: palette.borderSubtle,
                        padding: 6,
                        gap: 4,
                    }}
                >
                    <View
                        style={{
                            height: 4,
                            width: '70%',
                            borderRadius: 2,
                            backgroundColor: palette.textPrimary,
                        }}
                    />
                    <View
                        style={{
                            height: 4,
                            width: '45%',
                            borderRadius: 2,
                            backgroundColor: palette.textMuted,
                        }}
                    />
                </View>

                {/* The user's own bubble, then the accent button */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <View
                        style={{
                            flex: 1,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: palette.userBubbleBg,
                        }}
                    />
                    <View
                        style={{
                            width: 26,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: accent,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <Feather name="arrow-up" size={10} color={palette.accentPrimaryFg} />
                    </View>
                </View>
            </View>

            <View style={{ padding: theme.spacing.sm, gap: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text variant="caption" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                        {label}
                    </Text>
                    {selected ? (
                        <Feather name="check" size={13} color={theme.colors.accentPrimary} />
                    ) : null}
                </View>
                <Text variant="label" tone="tertiary" numberOfLines={1}>
                    {description}
                </Text>
            </View>
        </Pressable>
    );
}
