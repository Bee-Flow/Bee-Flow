/**
 * The web's WebpageLinkCard / DocumentLinkCard: a tile in the brand colour
 * with a globe or a page, the link's words, and an arrow. On the web a tap
 * opens the thing beside the chat; a phone has no beside, so it opens the
 * native screen (through the same link table every other link uses), or the
 * web page when there is no native one.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon, Text } from '@/shared/ui';

import type { LinkCardKind } from './linkCards';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        card: {
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: theme.spacing[2],
            maxWidth: 320,
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[2],
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgSecondary,
        },
        pressed: { opacity: 0.8 },
        tile: {
            width: 28,
            height: 28,
            borderRadius: theme.radii.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accentPrimary,
        },
        label: { flexShrink: 1 },
    }),
);

export function LinkCard({ kind, href, label }: { kind: LinkCardKind; href: string; label: string }) {
    const styles = useThemedStyles(sheet);
    const { open, t, theme } = useMarkdownEnv();
    const fallback =
        kind === 'webpage'
            ? t('mobile.markdown.open_webpage', 'Open webpage')
            : t('mobile.markdown.open_document', 'Open document');
    return (
        <Pressable
            onPress={() => open(href)}
            accessibilityRole="link"
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        >
            <View style={styles.tile}>
                <Icon name={kind === 'webpage' ? 'Globe' : 'FileText'} size={14} color={theme.colors.accentPrimaryFg} />
            </View>
            <Text variant="caption" weight="medium" numberOfLines={1} style={styles.label}>
                {label.trim() || fallback}
            </Text>
            <Icon name="ArrowRight" size={13} color={theme.colors.textTertiary} />
        </Pressable>
    );
}
