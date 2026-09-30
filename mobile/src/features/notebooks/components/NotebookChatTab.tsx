/**
 * The conversation half of a notebook, streamed from /ai/chat/notebook/stream.
 *
 * A notebook whose sources are still processing will answer badly, so this
 * half says so rather than letting the model shrug; and a history encrypted
 * with a key this device lacks is named as such, not shown as empty.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatMessage } from '@/features/chat';
import { Banner, ListSkeleton, useToast } from '@/shared/ui';

import { LibraryChat } from './LibraryChat';
import { useRefreshConversation } from '../hooks/mutations';
import { useNotebookConversation } from '../hooks/queries';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { flex: 1 },
        banner: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

function ChatBanner({ locked, workingCount }: { locked: boolean; workingCount: number }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (locked) {
        return (
            <View style={styles.banner}>
                <Banner tone="warning" icon="Lock">
                    {t('notebooks.history_locked', 'Chat history is locked — sign in again to continue this conversation.')}
                </Banner>
            </View>
        );
    }
    if (workingCount === 0) return null;
    return (
        <View style={styles.banner}>
            <Banner tone="info" icon="Clock">
                {t('mobile.notebooks.chat_still_processing', 'Sources still processing: {count}. Answers improve once they finish.', {
                    count: workingCount,
                })}
            </Banner>
        </View>
    );
}

export function NotebookChatTab({
    notebookId,
    documentContent,
    readyCount,
    workingCount,
    onNotebookChanged,
    onInsertAnswer,
}: {
    notebookId: string;
    /** The server builds a [DOCUMENT] block from this, so the model knows the notebook's own document. */
    documentContent: string;
    readyCount: number;
    workingCount: number;
    /** The AI added a source or rewrote the notes: re-read the notebook. */
    onNotebookChanged: () => void;
    /** Undefined while the notes cannot be edited here. */
    onInsertAnswer?: (content: string) => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const styles = useThemedStyles(makeStyles);
    const refreshConversation = useRefreshConversation(notebookId);
    const conversation = useNotebookConversation(notebookId, true);

    const history = useMemo<ChatMessage[]>(
        () =>
            (conversation.data?.messages ?? []).map((m, i) => ({
                // The stored turns have no ids of their own — they are a JSON
                // array inside one encrypted column — so position is the key.
                id: `stored-${i}`,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
            })),
        [conversation.data],
    );

    return (
        <View style={styles.root}>
            <ChatBanner locked={Boolean(conversation.data?.locked)} workingCount={workingCount} />
            {conversation.isLoading ? (
                <ListSkeleton rows={4} />
            ) : (
                <LibraryChat
                    streamPath="/ai/chat/notebook/stream"
                    extraBody={{ notebookId, documentContent }}
                    initialMessages={history}
                    locked={conversation.data?.locked}
                    emptyTitle={t('notebooks.chat_empty_title', 'Ask me anything')}
                    emptyMessage={
                        readyCount === 0
                            ? t('mobile.notebooks.chat_needs_source', 'Add a source first — right now there is nothing for it to read.')
                            : t('notebooks.chat_empty_body', "I'll use your notebook sources to provide accurate answers with citations.")
                    }
                    placeholder={t('notebooks.chat_input_placeholder', 'Ask about your sources...')}
                    onSourceAdded={() => {
                        toast(t('notebooks.source_added', 'Source added'), 'success');
                        onNotebookChanged();
                    }}
                    onDocumentUpdate={onNotebookChanged}
                    onInsertAnswer={
                        onInsertAnswer &&
                        ((content) => {
                            onInsertAnswer(content);
                            toast(t('mobile.notebooks.inserted', 'Added to the end of your notes'), 'success');
                        })
                    }
                    onTurnComplete={refreshConversation}
                />
            )}
        </View>
    );
}
