/**
 * Markdown rendering for chat.
 *
 * Uses react-native-marked's `useMarkdown` hook rather than its <Markdown>
 * component on purpose: that component renders into a FlatList, and a chat
 * transcript is already a FlatList. Nesting one inside the other produces the
 * "VirtualizedLists should never be nested" warning and, worse, breaks
 * scrolling and measurement for every message. The hook hands back plain
 * ReactNodes to drop into a View instead.
 *
 * The renderer subclass exists to paint with the app's own tokens — the
 * library's default theme has no idea about the eight Bee Flow themes — and to
 * make three chat-specific decisions:
 *
 *   - Code blocks scroll horizontally instead of wrapping. A wrapped shell
 *     command is unreadable and uncopyable.
 *   - Code blocks are long-pressable to copy. There is no right-click on a
 *     phone and an answer full of code you cannot extract is half an answer.
 *   - Links open in the system browser via expo-web-browser, so an external
 *     link never navigates away from an in-progress conversation.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import React, { useMemo, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';
import { Renderer, useMarkdown } from 'react-native-marked';

import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';

class BeeFlowRenderer extends Renderer {
    private theme: Theme;
    private copy: (text: string) => void;

    constructor(theme: Theme, copy: (text: string) => void) {
        super();
        this.theme = theme;
        this.copy = copy;
    }

    override code(text: string, language?: string, containerStyle?: ViewStyle): ReactNode {
        const t = this.theme;
        return (
            <Pressable
                key={this.getKey()}
                onLongPress={() => this.copy(text)}
                accessibilityRole="button"
                accessibilityLabel={`Code block${language ? ` in ${language}` : ''}. Long press to copy.`}
                style={[
                    {
                        backgroundColor: t.colors.bgTertiary,
                        borderRadius: t.radii.md,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: t.colors.borderSubtle,
                        marginVertical: t.spacing.sm,
                        overflow: 'hidden',
                    },
                    containerStyle,
                ]}
            >
                {language ? (
                    <View
                        style={{
                            paddingHorizontal: t.spacing.md,
                            paddingTop: t.spacing.sm,
                        }}
                    >
                        <Text variant="label" tone="tertiary">
                            {language}
                        </Text>
                    </View>
                ) : null}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ padding: t.spacing.md }}
                >
                    <Text variant="code" selectable>
                        {text}
                    </Text>
                </ScrollView>
            </Pressable>
        );
    }

    override codespan(text: string, styles?: TextStyle): ReactNode {
        const t = this.theme;
        return (
            <Text
                key={this.getKey()}
                variant="code"
                style={[
                    {
                        backgroundColor: t.colors.bgTertiary,
                        color: t.colors.accentPrimary,
                        borderRadius: t.radii.sm,
                    },
                    styles,
                ]}
            >
                {` ${text} `}
            </Text>
        );
    }

    override link(children: string | ReactNode[], href: string, styles?: TextStyle): ReactNode {
        const t = this.theme;
        return (
            <Text
                key={this.getKey()}
                accessibilityRole="link"
                onPress={() => openLink(href)}
                style={[{ color: t.colors.accentPrimary, textDecorationLine: 'underline' }, styles]}
            >
                {children}
            </Text>
        );
    }

    override blockquote(children: ReactNode[], styles?: ViewStyle): ReactNode {
        const t = this.theme;
        return (
            <View
                key={this.getKey()}
                style={[
                    {
                        borderLeftWidth: 3,
                        borderLeftColor: t.colors.accentPrimary,
                        paddingLeft: t.spacing.md,
                        marginVertical: t.spacing.sm,
                        opacity: 0.9,
                    },
                    styles,
                ]}
            >
                {children}
            </View>
        );
    }
}

/**
 * Open an external link in a Custom Tab.
 *
 * A Custom Tab keeps the app in the back stack, so returning lands on the same
 * message rather than a cold start. Falls back to the system handler for
 * anything that is not http(s) — mailto:, tel: and the like.
 */
async function openLink(href: string): Promise<void> {
    try {
        if (/^https?:\/\//i.test(href)) {
            await WebBrowser.openBrowserAsync(href, { createTask: false });
        } else {
            await Linking.openURL(href);
        }
    } catch {
        // A malformed href in a model answer is not worth an error dialog.
    }
}

export function Markdown({ value }: { value: string }) {
    const theme = useTheme();
    const { toast } = useToast();

    const copy = useMemo(
        () => (text: string) => {
            void Clipboard.setStringAsync(text);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            toast('Code copied');
        },
        [toast],
    );

    const renderer = useMemo(() => new BeeFlowRenderer(theme, copy), [theme, copy]);

    const styles = useMemo(
        () => ({
            text: { ...theme.type.body, color: theme.colors.textPrimary },
            paragraph: { marginVertical: theme.spacing.xs },
            strong: { fontFamily: 'Inter_600SemiBold' },
            em: { fontStyle: 'italic' as const },
            h1: { ...theme.type.title, color: theme.colors.textPrimary, marginTop: theme.spacing.md },
            h2: { ...theme.type.heading, color: theme.colors.textPrimary, marginTop: theme.spacing.md },
            h3: {
                ...theme.type.subheading,
                color: theme.colors.textPrimary,
                marginTop: theme.spacing.sm,
            },
            h4: { ...theme.type.subheading, color: theme.colors.textSecondary },
            h5: { ...theme.type.body, color: theme.colors.textSecondary },
            h6: { ...theme.type.caption, color: theme.colors.textMuted },
            li: { ...theme.type.body, color: theme.colors.textPrimary },
            list: { marginVertical: theme.spacing.xs },
            hr: {
                borderBottomColor: theme.colors.borderSubtle,
                borderBottomWidth: StyleSheet.hairlineWidth,
                marginVertical: theme.spacing.md,
            },
            table: {
                borderColor: theme.colors.borderSubtle,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: theme.radii.sm,
            },
            tableRow: { borderBottomColor: theme.colors.borderSubtle },
            tableCell: { padding: theme.spacing.sm },
        }),
        [theme],
    );

    const nodes = useMarkdown(value, { renderer, styles });

    return <View>{nodes}</View>;
}
