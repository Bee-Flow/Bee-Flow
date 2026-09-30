/**
 * A markdown-subset string, drawn.
 *
 * `text` and `callout.body` are markdown-typed props per componentSpecs.js, and
 * the phone was printing them raw — so `**spoed**` reached the screen with its
 * asterisks. Nested inside a parent <Text>, so it inherits the parent's
 * variant and tone and only overrides weight, style and colour.
 */

import React, { useMemo } from 'react';
import { Linking, StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { isPlain, parseInlineMarkdown } from '../model/inlineMarkdown';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bold: { fontWeight: '600' },
        italic: { fontStyle: 'italic' },
        link: { color: theme.colors.accentPrimary, textDecorationLine: 'underline' },
    });

export function InlineText({ text }: { text: string }) {
    const styles = useThemedStyles(makeStyles);
    const spans = useMemo(() => parseInlineMarkdown(text), [text]);
    if (isPlain(spans)) return <>{text}</>;
    return (
        <>
            {spans.map((span, i) => (
                <Text
                    key={`${i}-${span.text}`}
                    style={[
                        span.bold ? styles.bold : null,
                        span.italic ? styles.italic : null,
                        span.href ? styles.link : null,
                    ]}
                    onPress={span.href ? () => void Linking.openURL(span.href as string) : undefined}
                >
                    {span.text}
                </Text>
            ))}
        </>
    );
}
