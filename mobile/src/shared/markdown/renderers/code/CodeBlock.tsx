/**
 * A fenced code block, as the web's CollapsibleCodeBlock draws it: the dark
 * panel whatever the theme, a header with the language and Copy, GitHub Dark
 * highlighting, and a block taller than 240px folded to 200px behind a fade
 * with "Show more". Lines scroll sideways rather than wrap — a wrapped shell
 * command is unreadable and uncopyable — and the text stays selectable.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon } from '@/shared/ui';

import { CodeHeader } from './CodeHeader';
import { CODE_PANEL, SCOPE_STYLES } from './codeTheme';
import { languageLabel } from './languages';
import { useHighlight } from './useHighlight';
import { GradientFill } from '../rich/GradientFill';

/** The web's COLLAPSE_HEIGHT, and the 40px of slack it allows before folding. */
export const COLLAPSE_HEIGHT = 200;
const COLLAPSE_SLACK = 40;

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        panel: {
            backgroundColor: CODE_PANEL.background,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: CODE_PANEL.border,
            overflow: 'hidden',
        },
        folded: { maxHeight: COLLAPSE_HEIGHT, overflow: 'hidden' },
        code: { ...theme.type.code, lineHeight: 19, color: CODE_PANEL.text, paddingHorizontal: 12, paddingVertical: 9 },
        fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 50 },
        toggle: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            paddingVertical: 6,
            borderTopWidth: 1,
            borderTopColor: theme.colors.borderSubtle,
            backgroundColor: 'rgba(255,255,255,0.03)',
        },
        toggleText: { fontSize: 11, fontWeight: '600', color: theme.colors.accentPrimary },
    }),
);

const FADE = [
    { color: CODE_PANEL.background, opacity: 0 },
    { color: CODE_PANEL.background, opacity: 1 },
];

export function CodeBlock({ code, language }: { code: string; language: string }) {
    const styles = useThemedStyles(sheet);
    const { t, theme } = useMarkdownEnv();
    const runs = useHighlight(code, language);
    // Sticky, as on the web: once a block is tall enough to fold, it stays
    // foldable while more lines stream in.
    const [tall, setTall] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const folded = tall && !expanded;

    return (
        <View style={styles.panel}>
            <CodeHeader label={languageLabel(language)} code={code} />
            <View style={folded ? styles.folded : undefined}>
                <View onLayout={(e) => e.nativeEvent.layout.height > COLLAPSE_HEIGHT + COLLAPSE_SLACK && setTall(true)}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <Text selectable style={styles.code}>
                            {runs
                                ? runs.map((run, i) => (
                                      <Text key={i} style={run.scope ? SCOPE_STYLES[run.scope] : undefined}>
                                          {run.text}
                                      </Text>
                                  ))
                                : code}
                        </Text>
                    </ScrollView>
                </View>
                {folded ? (
                    <View style={styles.fade} pointerEvents="none">
                        <GradientFill stops={FADE} angle={180} />
                    </View>
                ) : null}
            </View>
            {tall ? (
                <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" style={styles.toggle}>
                    <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={12} color={theme.colors.accentPrimary} />
                    <Text style={styles.toggleText}>
                        {expanded ? t('mobile.markdown.show_less', 'Show less') : t('mobile.markdown.show_more', 'Show more')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}
