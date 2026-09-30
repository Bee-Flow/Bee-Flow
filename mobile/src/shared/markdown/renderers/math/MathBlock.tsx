/**
 * A `$$…$$` display formula: centred, and scrollable sideways when it is wider
 * than the phone (a long equation shrunk to fit would be unreadable). While
 * its closing `$$` is still streaming in, and whenever it cannot be typeset,
 * the TeX is shown as written in a monospace box.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';

import { blockMathStyle } from './mathLayout';
import { renderTex } from './renderTex';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.spacing[1] },
        source: {
            backgroundColor: theme.colors.bgTertiary,
            borderRadius: theme.radii.md,
            padding: theme.spacing[3],
        },
        sourceText: { ...theme.type.code, color: theme.colors.textSecondary },
    }),
);

export function MathBlock({ tex, pending }: { tex: string; pending: boolean }) {
    const { theme } = useMarkdownEnv();
    const styles = useThemedStyles(sheet);
    const math = pending ? null : renderTex(tex, true, theme.type.body.fontSize);

    if (!math) {
        return (
            <View style={styles.source}>
                <Text selectable style={styles.sourceText}>
                    {tex}
                </Text>
            </View>
        );
    }
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
            <View style={blockMathStyle(math)} accessible accessibilityLabel={tex}>
                <SvgXml xml={math.xml} width={math.width} height={math.height} color={theme.colors.textPrimary} />
            </View>
        </ScrollView>
    );
}
