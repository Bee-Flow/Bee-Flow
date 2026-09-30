/**
 * A map in an answer. The web frames Google's embed; with no WebView the
 * phone shows the web's title bar (📍 title, "Open in Maps ↗") over a panel
 * naming the place or the route, and a tap anywhere opens it in Maps —
 * where a phone user would take a route anyway.
 */

import React from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon, Text } from '@/shared/ui';

import type { MapData } from './mapModel';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        frame: {
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgTertiary,
            overflow: 'hidden',
        },
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing[2],
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[2],
            backgroundColor: 'rgba(255, 255, 255, 0.04)',
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.borderSubtle,
        },
        title: { flexShrink: 1 },
        panel: { alignItems: 'center', justifyContent: 'center', gap: theme.spacing[2], padding: theme.spacing[5], minHeight: 120 },
        route: { alignItems: 'center', gap: theme.spacing[1] },
    }),
);

export function MapCard({ map }: { map: MapData }) {
    const styles = useThemedStyles(sheet);
    const { t, theme } = useMarkdownEnv();
    const open = () => void Linking.openURL(map.mapsLink).catch(() => undefined);
    const openLabel = t('mobile.markdown.open_in_maps', 'Open in Maps');
    const title = map.title || t('mobile.markdown.map', 'Map');

    return (
        <Pressable onPress={open} accessibilityRole="link" accessibilityLabel={`${title}. ${openLabel}`} style={styles.frame}>
            <View style={styles.bar}>
                <Text variant="caption" weight="semibold" tone="secondary" numberOfLines={1} style={styles.title}>
                    {`📍 ${title}`}
                </Text>
                <Text variant="caption" tone="accent">{`${openLabel} ↗`}</Text>
            </View>
            <View style={styles.panel}>
                <Icon name="MapPin" size={28} color={theme.colors.accentPrimary} />
                {map.route ? (
                    <View style={styles.route}>
                        <Text variant="body" center numberOfLines={2}>{map.route.origin}</Text>
                        <Icon name="ArrowDown" size={14} color={theme.colors.textTertiary} />
                        <Text variant="body" center numberOfLines={2}>{map.route.destination}</Text>
                    </View>
                ) : map.place ? (
                    <Text variant="body" center numberOfLines={3}>{map.place}</Text>
                ) : null}
            </View>
        </Pressable>
    );
}
