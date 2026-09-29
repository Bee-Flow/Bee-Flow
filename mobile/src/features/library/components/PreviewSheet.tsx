/**
 * Preview what can honestly be previewed.
 *
 * Three renderers and one refusal:
 *
 *   text      — selectable, monospaced-when-it-should-be. This is what the
 *               server actually stores for a source or a KB document: the
 *               extracted text, not the original bytes. Saying so matters,
 *               because a person who uploaded a 40-page PDF and sees plain
 *               text should know they are looking at what the model sees.
 *   markdown  — the same content through the chat renderer, for anything the
 *               server produced as markdown (URL sources are converted).
 *   image     — expo-image, which is the whole story for a photo or a scan.
 *   binary    — no renderer. Offer "Open with…" and say why, rather than
 *               drawing a grey rectangle labelled "preview".
 *
 * There is no WebView in this app, and this file is the reason that stays
 * true: a WebView is the tempting way to fake a PDF viewer, and it would put
 * a browser engine — with its own cookie jar and its own attack surface —
 * inside a privacy product.
 */

import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { ErrorState, LoadingState } from '../../../ui/Feedback';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { Markdown } from '../../chat/Markdown';

export type PreviewKind = 'text' | 'markdown' | 'image' | 'binary';

export interface PreviewSheetProps {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    kind: PreviewKind;
    /** Body for the text/markdown renderers. */
    content?: string;
    /** Local or absolute uri for the image renderer. */
    imageUri?: string;
    loading?: boolean;
    error?: unknown;
    onRetry?: () => void;
    /** Hands the file to the Android share sheet. */
    onShare?: () => void;
    /** For `binary`: the only sensible action. */
    onOpenWith?: () => void;
    busyAction?: boolean;
}

export function PreviewSheet({
    visible,
    onClose,
    title,
    subtitle,
    kind,
    content,
    imageUri,
    loading = false,
    error,
    onRetry,
    onShare,
    onOpenWith,
    busyAction = false,
}: PreviewSheetProps) {
    const theme = useTheme();

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            scroll={false}
            tall
            footer={
                onShare || onOpenWith ? (
                    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                        {onOpenWith ? (
                            <Button
                                label="Open with…"
                                onPress={onOpenWith}
                                loading={busyAction}
                                icon={
                                    <Feather
                                        name="external-link"
                                        size={16}
                                        color={theme.colors.accentPrimaryFg}
                                    />
                                }
                                style={{ flex: 1 }}
                            />
                        ) : null}
                        {onShare ? (
                            <Button
                                label="Share"
                                variant="secondary"
                                onPress={onShare}
                                loading={busyAction && !onOpenWith}
                                icon={
                                    <Feather name="share-2" size={16} color={theme.colors.textPrimary} />
                                }
                                style={{ flex: 1 }}
                            />
                        ) : null}
                    </View>
                ) : undefined
            }
        >
            <View style={{ flexShrink: 1, minHeight: 200 }}>
                {loading ? (
                    <LoadingState label="Loading the text…" />
                ) : error ? (
                    <ErrorState error={error} onRetry={onRetry} />
                ) : kind === 'image' && imageUri ? (
                    <View style={{ padding: theme.spacing.lg, alignItems: 'center' }}>
                        <Image
                            source={{ uri: imageUri }}
                            style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: theme.radii.md }}
                            contentFit="contain"
                            transition={120}
                            accessibilityLabel={title}
                        />
                    </View>
                ) : kind === 'binary' ? (
                    <View
                        style={{
                            padding: theme.spacing.xxl,
                            alignItems: 'center',
                            gap: theme.spacing.md,
                        }}
                    >
                        <Feather name="file" size={28} color={theme.colors.textMuted} />
                        <Text variant="body" tone="tertiary" center>
                            Bee Flow does not render this format on the phone. Open it with an app that
                            can — the file is fetched from your server and handed over directly.
                        </Text>
                    </View>
                ) : !content?.trim() ? (
                    <View style={{ padding: theme.spacing.xxl }}>
                        <Text variant="body" tone="tertiary" center>
                            There is no extracted text for this yet. If it was added recently, the
                            server may still be processing it.
                        </Text>
                    </View>
                ) : (
                    <ScrollView
                        contentContainerStyle={{
                            paddingHorizontal: theme.spacing.lg,
                            paddingBottom: theme.spacing.xl,
                        }}
                    >
                        {kind === 'markdown' ? (
                            <Markdown value={content} />
                        ) : (
                            <Text variant="body" selectable>
                                {content}
                            </Text>
                        )}
                    </ScrollView>
                )}
            </View>
        </Sheet>
    );
}
