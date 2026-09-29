/**
 * A chat surface scoped to one thing in the Library.
 *
 * Notebook chat and template chat are the same interaction — ask a question,
 * the model answers from THIS notebook's sources or THIS template's
 * placeholders — so they share a component. What differs is the endpoint and
 * the two or three body fields it wants, which is exactly what `streamPath`
 * and `extraBody` are.
 *
 * The transcript and the composer are the ones from src/features/chat: a
 * second bubble style and a second attachment picker in the same app would be
 * two ways to do the same thing, and the one in `chat/` is already the careful
 * one.
 *
 * History is sent on EVERY turn here, unlike direct chat. Both server runtimes
 * build their prompt from `req.body.history` and neither reads the persisted
 * transcript back (notebookChat.js line ~530, templateChat.js line ~253) — the
 * stored copy exists so the panel can rehydrate, not so the model can. The
 * server trims it to a token budget, so sending the lot is safe.
 */

import { useQuery } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { EmptyState } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';
import { encodeAttachments, toWire } from '../../chat/attachments';
import { Composer, type ComposerSettings } from '../../chat/Composer';
import { MessageBubble } from '../../chat/MessageBubble';
import { fetchTiers, tierKeys } from '../../chat/tiers';
import type { Attachment, ChatMessage } from '../../chat/types';
import type { NotebookSource } from '../types';
import { useLibraryChatStream } from '../useLibraryChatStream';

const DEFAULT_SETTINGS: ComposerSettings = {
    // `auto` is the only tier the server always offers. The two runtimes here
    // both collapse `standard` back to `fast`, so nothing else is safe to
    // assume without asking /ai/config/tiers-for-user first.
    modelTier: 'auto',
    // The notebook IS the source here; retrieval runs against it server-side.
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: true,
};

export interface LibraryChatProps {
    /** Full client path, e.g. '/ai/chat/notebook/stream'. */
    streamPath: string;
    /** Runtime-specific body fields: notebookId + documentContent, or templateId. */
    extraBody: Record<string, unknown>;
    /** The persisted transcript, rehydrated by the caller. */
    initialMessages: ChatMessage[];
    /** Encrypted history this session cannot open — the composer stays shut. */
    locked?: boolean;
    emptyTitle: string;
    emptyMessage: string;
    placeholder?: string;
    onDocumentUpdate?: (content: string, title?: string, version?: number) => void;
    onSourceAdded?: (source: NotebookSource) => void;
    /** Fires once a turn settles, so the caller can re-read the stored copy. */
    onTurnComplete?: () => void;
}

export function LibraryChat({
    streamPath,
    extraBody,
    initialMessages,
    locked = false,
    emptyTitle,
    emptyMessage,
    placeholder,
    onDocumentUpdate,
    onSourceAdded,
    onTurnComplete,
}: LibraryChatProps) {
    const theme = useTheme();
    const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
    /** Turns added since this panel opened, ahead of the server round-trip. */
    const [local, setLocal] = useState<ChatMessage[]>([]);

    const tiersQuery = useQuery({
        queryKey: tierKeys.forTask('direct_chat'),
        queryFn: ({ signal }) => fetchTiers('direct_chat', signal),
        // Entitlements change rarely, and a refetch mid-conversation would
        // reshuffle the tier row under somebody's thumb.
        staleTime: 10 * 60_000,
    });

    const { turn, streaming, send, stop } = useLibraryChatStream({
        onDocumentUpdate,
        onSourceAdded,
        onDone: (finished) => {
            setLocal((prev) =>
                prev.map((m) =>
                    m.streaming
                        ? {
                              ...m,
                              streaming: false,
                              content: finished.text || m.content,
                              thinking: finished.thinking || undefined,
                              tools: finished.tools,
                              sources: finished.sources,
                              error: finished.error ?? undefined,
                              // Nothing arrived and nothing failed: the socket
                              // died, which on a phone is a walk out of wifi.
                              interrupted: !finished.error && !finished.text ? true : undefined,
                          }
                        : m,
                ),
            );
            onTurnComplete?.();
        },
        onUnhandled: (event) => {
            if (__DEV__) console.warn(`[library-chat] unhandled SSE event: ${event}`);
        },
    });

    /** Persisted first, then anything this session added. Reversed for the inverted list. */
    const messages = useMemo(
        () => [...initialMessages, ...local].slice().reverse(),
        [initialMessages, local],
    );

    const handleSend = useCallback(
        (text: string, attachments: Attachment[]) => {
            const userMessage: ChatMessage = {
                id: Crypto.randomUUID(),
                role: 'user',
                content: text,
                attachments,
                createdAt: new Date().toISOString(),
            };
            const placeholderMessage: ChatMessage = {
                id: Crypto.randomUUID(),
                role: 'assistant',
                content: '',
                streaming: true,
            };

            const history = [...initialMessages, ...local]
                .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
                .map((m) => ({ role: m.role, content: m.content }));

            setLocal((prev) => [...prev, userMessage, placeholderMessage]);

            void (async () => {
                let wire;
                try {
                    // Attachments ride INLINE in the turn body as base64 data
                    // URLs — neither runtime has an upload endpoint — so they
                    // are resized and budget-checked before anything is sent.
                    wire = toWire(await encodeAttachments(attachments));
                } catch (err) {
                    setLocal((prev) =>
                        prev.map((m) =>
                            m.id === placeholderMessage.id
                                ? { ...m, streaming: false, error: (err as Error).message }
                                : m,
                        ),
                    );
                    return;
                }

                await send(streamPath, {
                    ...extraBody,
                    message: text,
                    history,
                    modelTier: settings.modelTier,
                    attachments: wire,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
            })();
        },
        [extraBody, initialMessages, local, send, settings.modelTier, streamPath],
    );

    return (
        <View style={{ flex: 1 }}>
            {messages.length === 0 ? (
                <EmptyState icon="message-circle" title={emptyTitle} message={emptyMessage} />
            ) : (
                <FlatList
                    data={messages}
                    keyExtractor={(m) => m.id}
                    renderItem={({ item }) => (
                        <MessageBubble
                            message={item}
                            streamingText={item.streaming ? turn.text : undefined}
                        />
                    )}
                    inverted
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingVertical: theme.spacing.md }}
                    initialNumToRender={10}
                    maxToRenderPerBatch={8}
                    windowSize={9}
                    removeClippedSubviews
                />
            )}

            {turn.blocked ? (
                <View
                    accessibilityLiveRegion="polite"
                    style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}
                >
                    <Text variant="caption" tone="warning">
                        {turn.blocked.reason}
                        {turn.blocked.detail ? ` ${turn.blocked.detail}` : ''}
                    </Text>
                </View>
            ) : null}

            <Composer
                onSend={handleSend}
                onStop={stop}
                streaming={streaming}
                settings={settings}
                onSettingsChange={setSettings}
                tiers={tiersQuery.data ?? {}}
                sources={false}
                placeholder={placeholder}
                disabledReason={
                    locked || turn.locked
                        ? 'This conversation is encrypted with a key this device does not have.'
                        : null
                }
            />
        </View>
    );
}
