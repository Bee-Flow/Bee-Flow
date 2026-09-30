/**
 * A person's mark: their picture, or initials on a colour derived from their
 * name.
 *
 * Depends on core/api/server only to resolve a server-relative avatar path;
 * shared → core is the allowed direction.
 */

import { Image } from 'expo-image';
import React from 'react';
import { View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';

import { apiUrl } from '@/core/api/server';
import { useTheme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

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
