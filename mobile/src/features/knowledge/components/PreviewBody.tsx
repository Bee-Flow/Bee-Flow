/** The preview sheet's body: loading, error, an image, a refusal, or the text. */

import { Image } from 'expo-image';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown/Markdown';
import { ErrorState, Icon, LoadingState, Text } from '@/shared/ui';

export type PreviewKind = 'text' | 'markdown' | 'image' | 'binary';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        image: { padding: theme.spacing.lg, alignItems: 'center' },
        picture: { width: '100%', aspectRatio: 3 / 4, borderRadius: theme.radii.md },
        binary: { padding: theme.spacing.xxl, alignItems: 'center', gap: theme.spacing.md },
        empty: { padding: theme.spacing.xxl },
        scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xl },
    });

function PreviewText({ kind, content }: { kind: PreviewKind; content: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView contentContainerStyle={styles.scroll}>
            {kind === 'markdown' ? (
                <Markdown value={content} />
            ) : (
                <Text variant="body" selectable>
                    {content}
                </Text>
            )}
        </ScrollView>
    );
}

export function PreviewBody({
    title,
    kind,
    content,
    imageUri,
    loading = false,
    error,
    onRetry,
}: {
    title: string;
    kind: PreviewKind;
    content?: string;
    imageUri?: string;
    loading?: boolean;
    error?: unknown;
    onRetry?: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (loading) return <LoadingState label="Loading the text…" />;
    if (error) return <ErrorState error={error} onRetry={onRetry} />;
    if (kind === 'image' && imageUri) {
        return (
            <View style={styles.image}>
                <Image
                    source={{ uri: imageUri }}
                    style={styles.picture}
                    contentFit="contain"
                    transition={120}
                    accessibilityLabel={title}
                />
            </View>
        );
    }
    if (kind === 'binary') {
        return (
            <View style={styles.binary}>
                <Icon name="File" size={28} color={theme.colors.textMuted} />
                <Text variant="body" tone="tertiary" center>
                    Bee Flow does not render this format on the phone. Open it with an app that
                    can — the file is fetched from your server and handed over directly.
                </Text>
            </View>
        );
    }
    if (!content?.trim()) {
        return (
            <View style={styles.empty}>
                <Text variant="body" tone="tertiary" center>
                    There is no extracted text for this yet. If it was added recently, the
                    server may still be processing it.
                </Text>
            </View>
        );
    }
    return <PreviewText kind={kind} content={content} />;
}
