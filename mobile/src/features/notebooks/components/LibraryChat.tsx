/**
 * A chat surface scoped to one thing in the Library.
 *
 * Notebook chat and template chat are the same interaction — ask a question,
 * the model answers from THIS notebook's sources or THIS template's
 * placeholders — so they share a component. What differs is the endpoint and
 * the two or three body fields it wants, which is exactly what `streamPath`
 * and `extraBody` are. Templates import it from '@/features/notebooks'.
 *
 * The transcript and the composer are the ones from features/chat: a second
 * bubble style and a second attachment picker would be two ways to do the
 * same thing, and the one in chat is already the careful one.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Composer, MessageBubble, useTiers, type ChatMessage, type ComposerSettings } from '@/features/chat';
import { Button, EmptyState, Text } from '@/shared/ui';

import { useLibraryTurns } from '../hooks/useLibraryTurns';
import type { NotebookSource } from '../model/types';

const DEFAULT_SETTINGS: ComposerSettings = {
    // `auto` is the only tier the server always offers. Both runtimes here
    // collapse `standard` back to `fast`, so nothing else is safe to assume
    // without asking /ai/config/tiers-for-user first.
    modelTier: 'auto',
    // The notebook IS the source here; retrieval runs against it server-side.
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: true,
};

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { flex: 1 },
        list: { paddingVertical: theme.spacing.md },
        blocked: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        insert: { alignItems: 'flex-start', paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

/**
 * A settled answer, with the web's "Insert into document" under it
 * (NotebookChat.jsx) when the caller has a document to put it in.
 */
function ChatRow({
    message,
    streamingText,
    onInsertAnswer,
}: {
    message: ChatMessage;
    streamingText?: string;
    onInsertAnswer?: (content: string) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const insertable = onInsertAnswer && message.role === 'assistant' && !message.streaming && message.content.trim();
    return (
        <View>
            <MessageBubble message={message} streamingText={streamingText} />
            {insertable ? (
                <View style={styles.insert}>
                    <Button
                        label={t('notebooks.insert_into_document', 'Insert into document')}
                        variant="ghost"
                        size="sm"
                        iconName="ArrowDown"
                        onPress={() => onInsertAnswer(message.content)}
                    />
                </View>
            ) : null}
        </View>
    );
}

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
    /** Offers "Insert into document" under each settled answer. */
    onInsertAnswer?: (content: string) => void;
    /** Fires as a turn is sent: the conversation now holds something closing it would lose. */
    onTurnSent?: () => void;
}

export function LibraryChat({
    locked = false,
    emptyTitle,
    emptyMessage,
    placeholder,
    onDocumentUpdate,
    onSourceAdded,
    onInsertAnswer,
    onTurnSent,
    ...rest
}: LibraryChatProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
    // The same entitlement read (and query key) as direct chat.
    const tiers = useTiers('direct_chat');
    const { messages, turn, streaming, send, stop } = useLibraryTurns({
        ...rest,
        modelTier: settings.modelTier,
        callbacks: { onDocumentUpdate, onSourceAdded },
    });

    return (
        <View style={styles.root}>
            {messages.length === 0 ? (
                <EmptyState icon="MessageCircle" title={emptyTitle} message={emptyMessage} />
            ) : (
                <FlatList
                    data={messages}
                    keyExtractor={(m) => m.id}
                    renderItem={({ item }) => (
                        <ChatRow
                            message={item}
                            streamingText={item.streaming ? turn.text : undefined}
                            onInsertAnswer={onInsertAnswer}
                        />
                    )}
                    inverted
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.list}
                    initialNumToRender={10}
                    maxToRenderPerBatch={8}
                    windowSize={9}
                    removeClippedSubviews
                />
            )}

            {turn.blocked ? (
                <View accessibilityLiveRegion="polite" style={styles.blocked}>
                    <Text variant="caption" tone="warning">
                        {turn.blocked.reason}
                        {turn.blocked.detail ? ` ${turn.blocked.detail}` : ''}
                    </Text>
                </View>
            ) : null}

            <Composer
                onSend={(text, attachments) => {
                    onTurnSent?.();
                    send(text, attachments);
                }}
                onStop={stop}
                streaming={streaming}
                settings={settings}
                onSettingsChange={setSettings}
                tiers={tiers.data ?? {}}
                sources={false}
                placeholder={placeholder}
                disabledReason={
                    locked || turn.locked
                        ? t('notebooks.history_locked', 'Chat history is locked — sign in again to continue this conversation.')
                        : null
                }
            />
        </View>
    );
}
