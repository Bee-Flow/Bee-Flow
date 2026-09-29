/**
 * Badges, chips and avatars — the small identity/status marks.
 */

import { Image } from 'expo-image';
import React from 'react';
import {
    Pressable,
    StyleSheet,
    View,
    type ImageStyle,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { Text } from './Text';
import { apiUrl } from '../api/server';
import { useTheme } from '../theme/ThemeProvider';


/**
 * `ai` is the builder's step-family blue (`--type-ai` on the web), not the
 * org's brandable accent — a running run has to look the same in every
 * organisation, and `accent` is grey by default.
 */
export type BadgeTone = 'neutral' | 'accent' | 'ai' | 'success' | 'warning' | 'error';

export function Badge({
    label,
    tone = 'neutral',
    style,
}: {
    label: string;
    tone?: BadgeTone;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    const fg = {
        // `textTertiary`, not `textMuted`: a badge label is text and has to
        // clear 4.5:1 like any other. See the note on TextTone in ui/Text.tsx.
        neutral: theme.colors.textTertiary,
        accent: theme.colors.accentPrimary,
        ai: theme.colors.typeAi,
        success: theme.colors.success,
        warning: theme.colors.warning,
        error: theme.colors.error,
    }[tone];

    return (
        <View
            style={[
                {
                    paddingHorizontal: theme.spacing.sm,
                    paddingVertical: 3,
                    borderRadius: theme.radii.sm,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: fg,
                    alignSelf: 'flex-start',
                },
                style,
            ]}
        >
            <Text variant="label" style={{ color: fg }} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

/** A selectable chip — filters, model tiers, label pickers. */
export function Chip({
    label,
    selected = false,
    onPress,
    icon,
    style,
    accessibilityHint,
}: {
    label: string;
    selected?: boolean;
    onPress?: () => void;
    icon?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    /**
     * What tapping it does, when that is not obvious from the label.
     *
     * A chip is a label in a rounded box, so a screen reader announces
     * "Contracts, button, selected" whether tapping it selects, deselects or
     * removes. For a chip that REMOVES something the difference is the whole
     * meaning, and the little × is invisible to TalkBack.
     */
    accessibilityHint?: string;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            disabled={!onPress}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                    minHeight: 36,
                    paddingHorizontal: theme.spacing.md,
                    borderRadius: theme.radii.pill,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: selected ? theme.colors.accentText : theme.colors.borderDefault,
                    backgroundColor: selected
                        ? theme.colors.itemActiveBg
                        : pressed
                          ? theme.colors.itemHoverBg
                          : 'transparent',
                },
                style,
            ]}
        >
            {icon}
            <Text variant="caption" tone={selected ? 'accent' : 'secondary'} weight="medium">
                {label}
            </Text>
        </Pressable>
    );
}

/**
 * Avatar.
 *
 * The server stores either a URL or a data URI (`avatarType`), and for users
 * with neither we draw initials on a colour derived from the id — stable per
 * person, so the same colleague is the same colour on every screen, which is
 * what makes an avatar scannable in a list at all.
 */
export function Avatar({
    name,
    uri,
    size = 40,
    style,
}: {
    name: string;
    uri?: string | null;
    size?: number;
    // An avatar is either an <Image> or a <View> of initials, so the style has
    // to satisfy both. Callers only ever pass layout properties.
    style?: StyleProp<ViewStyle & ImageStyle>;
}) {
    const theme = useTheme();

    const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');

    if (uri) {
        // A relative avatar path is server-relative; absolute and data: URIs
        // pass through untouched.
        const source =
            uri.startsWith('http') || uri.startsWith('data:') ? uri : safeApiUrl(uri);
        if (source) {
            return (
                <Image
                    source={{ uri: source }}
                    accessibilityLabel={name}
                    style={[{ width: size, height: size, borderRadius: size / 2 }, style]}
                    contentFit="cover"
                    transition={120}
                />
            );
        }
    }

    return (
        <View
            accessibilityLabel={name}
            style={[
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: tintFor(name, theme.dark),
                },
                style,
            ]}
        >
            <Text
                variant="caption"
                weight="semibold"
                style={{ color: theme.dark ? '#0f0f13' : '#ffffff', fontSize: size * 0.36 }}
            >
                {initials || '?'}
            </Text>
        </View>
    );
}

function safeApiUrl(path: string): string | null {
    try {
        return apiUrl(path);
    } catch {
        // No server configured yet — fall through to initials rather than
        // throwing from inside a list row.
        return null;
    }
}

/**
 * A stable pastel (dark theme) or deep (light theme) tint from a name.
 * Hue only — saturation and lightness are fixed so no avatar can come out
 * unreadable against its own initials.
 */
function tintFor(seed: string, dark: boolean): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    return dark ? `hsl(${hue}, 45%, 68%)` : `hsl(${hue}, 42%, 42%)`;
}
