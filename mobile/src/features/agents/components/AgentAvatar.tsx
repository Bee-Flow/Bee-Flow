/**
 * An agent's mark.
 *
 * Three cases, and the middle one is why this is not just `<Avatar>`: most
 * agents are given an EMOJI rather than a picture, and an emoji handed to an
 * <Image> renders as empty space. So emoji is drawn as text, anything
 * image-shaped is delegated to the kit's Avatar (which already resolves a
 * server-relative path and falls back to initials), and an agent with neither
 * gets initials on a colour derived from its name.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Avatar, Text } from '@/shared/ui';

import { isImageAvatar } from '../model/avatar';


export function AgentAvatar({
    name,
    avatar,
    size = 40,
}: {
    name: string;
    avatar?: string | null;
    size?: number;
}) {
    const theme = useTheme();

    if (avatar && !isImageAvatar(avatar)) {
        return (
            <View
                accessibilityLabel={name}
                style={{
                    width: size,
                    height: size,
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.bgTertiary,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {/* Emoji ignores the type scale's font family, so only the size
                    matters here; it is tied to the box so a 64px avatar on the
                    detail screen does not show a 20px face in a big square. */}
                <Text
                    variant="body"
                    style={{ fontSize: size * 0.5, lineHeight: size * 0.62 }}
                    maxFontSizeMultiplier={1}
                >
                    {avatar}
                </Text>
            </View>
        );
    }

    return <Avatar name={name} uri={avatar ?? undefined} size={size} />;
}
