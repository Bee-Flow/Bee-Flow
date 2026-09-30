/**
 * A research report's reference list: "📚 Sources (n)", folding like the
 * web's, over one card per source — its site icon, its title (or its domain)
 * and the domain beneath. A tap opens the page in a Custom Tab, as every
 * outside link from an answer does.
 */

import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon, Text } from '@/shared/ui';

import { sourceDomain, type ResearchSource } from './researchModel';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        wrap: { gap: theme.spacing[2] },
        toggle: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
        card: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing[3],
            paddingVertical: theme.spacing[3],
            paddingHorizontal: theme.spacing[4],
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgTertiary,
        },
        pressed: { borderColor: theme.colors.accentPrimary },
        favicon: { width: 20, height: 20, borderRadius: 4 },
        words: { flex: 1, minWidth: 0 },
    }),
);

/** The web's favicon service, which the web's source cards use too. */
function faviconOf(url: string): string | null {
    try {
        return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
    } catch {
        return null;
    }
}

function SourceCard({ source }: { source: ResearchSource }) {
    const styles = useThemedStyles(sheet);
    const { open, theme } = useMarkdownEnv();
    const [iconFailed, setIconFailed] = useState(false);
    const icon = iconFailed ? null : faviconOf(source.url);
    const domain = sourceDomain(source.url);
    return (
        <Pressable onPress={() => open(source.url)} accessibilityRole="link" style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
            {icon ? <Image source={{ uri: icon }} style={styles.favicon} onError={() => setIconFailed(true)} /> : null}
            <View style={styles.words}>
                <Text variant="caption" weight="medium" numberOfLines={1}>
                    {source.title || domain}
                </Text>
                <Text variant="label" tone="tertiary" numberOfLines={1}>
                    {domain}
                </Text>
            </View>
            <Icon name="ExternalLink" size={14} color={theme.colors.textMuted} />
        </Pressable>
    );
}

export function ResearchSources({ items }: { items: ResearchSource[] }) {
    const styles = useThemedStyles(sheet);
    const { t, theme } = useMarkdownEnv();
    const [collapsed, setCollapsed] = useState(false);
    return (
        <View style={styles.wrap}>
            <Pressable
                onPress={() => setCollapsed((c) => !c)}
                accessibilityRole="button"
                accessibilityState={{ expanded: !collapsed }}
                style={styles.toggle}
            >
                <Icon name={collapsed ? 'ChevronRight' : 'ChevronDown'} size={16} color={theme.colors.textPrimary} />
                <Text variant="caption" weight="semibold">
                    {`📚 ${t('mobile.markdown.research_sources', 'Sources ({count})', { count: items.length })}`}
                </Text>
            </Pressable>
            {collapsed ? null : items.map((source, i) => <SourceCard key={i} source={source} />)}
        </View>
    );
}
