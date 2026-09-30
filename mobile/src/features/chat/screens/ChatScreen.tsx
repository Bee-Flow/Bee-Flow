/**
 * The conversation screen: header, transcript, what the live turn says, and
 * the composer. The conversation itself — transcript, stream, send, retry —
 * is useDirectChat; the settings are useComposerSettings.
 *
 * Nothing here subscribes to the streaming text. The transcript's streaming
 * cell does, and the notices subscribe to their own fields, so a flush does
 * not re-render the header, the composer or any finished answer.
 *
 * Leaving while an answer is being written asks first (useAnswerLeaveGuard):
 * the screen's stream closes with it, which stops the answer, and some
 * providers then save nothing of the turn.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { consumePendingShare, describeSharedPayload } from '@/features/search';
import { ErrorState, Icon, IconButton, LoadingState, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { Composer } from '../components/composer/Composer';
import { ChatTranscript } from '../components/transcript/ChatTranscript';
import { TurnNotices } from '../components/transcript/TurnNotices';
import { useAnswerLeaveGuard } from '../hooks/useAnswerLeaveGuard';
import { useChatSurface } from '../hooks/useChatSurface';
import { useComposerSettings, useConversationGrounding } from '../hooks/useComposerSettings';
import { useDirectChat } from '../hooks/useDirectChat';
import type { Attachment } from '../model/types';

export interface ChatScreenProps {
    /** A conversation id, or `new`. */
    id: string | undefined;
    /** Knowledge bases to start with, comma-separated ("Ask about this" routes with ?kb=). */
    kb?: string;
    /** A message from the home screen's composer, sent once on mount. */
    draft?: string;
    /** A project a new chat starts in (a project's "New chat" routes with ?project=). */
    project?: string;
    /** The home composer's brain switch was off when the draft was sent. */
    memoryOff?: boolean;
}

/**
 * Text and files handed over by Android's share sheet. Drained ONCE, on
 * mount, and only into a new chat: `consumePendingShare` clears the staged
 * payload as it returns it, so a re-render cannot re-attach the same file.
 */
function useSharedDraft(isNew: boolean): { text: string; attachments: Attachment[] } {
    const [shared] = useState(() => {
        const payload = isNew ? consumePendingShare() : null;
        const content = payload ? describeSharedPayload(payload) : null;
        return {
            text: content?.text ?? '',
            attachments: (content?.files ?? []).map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                // The share sheet reports null for a size it could not
                // determine; encodeAttachments measures it after the read.
                size: file.size ?? undefined,
                // Already a readable local path, resized and encoded at send
                // time like any other pick.
                uri: file.uri,
            })),
        };
    });
    return shared;
}

export function ChatScreen({ id, kb, draft, project, memoryOff }: ChatScreenProps) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const { toast } = useToast();
    // The tier dial's brain icon. Per conversation, not persisted: pausing
    // memory is a decision about what you are about to say.
    const [memoryEnabled, setMemoryEnabled] = useState(!memoryOff);
    const composer = useComposerSettings(kb);
    const chat = useDirectChat({ id, draft, settings: composer.settings, memoryEnabled, project });
    const shared = useSharedDraft(chat.isNew);
    const { conversationId, query, stream } = chat;
    const conversation = query.data;
    useConversationGrounding(composer.ground, conversationId, conversation?.knowledgeBaseIds);
    useAnswerLeaveGuard(stream.streaming, conversationId);

    const surface = useChatSurface({
        conversationId,
        streaming: stream.streaming,
        tiers: composer.tiers,
        conversation: chat.conversation,
        onRetry: chat.handleRetry,
        onEdit: chat.handleEdit,
        kbRefusal: composer.kbRefusal,
        thread: conversation?.shared_scope === 'project' ? { title: conversation.title } : null,
    });
    const memory = useMemo(() => ({ enabled: memoryEnabled, onToggle: () => setMemoryEnabled((v) => !v) }), [memoryEnabled]);
    const openDetails = useCallback(() => router.push(`/chat/${conversationId}/details`), [router, conversationId]);
    const openVoice = useCallback(() => router.push('/voice'), [router]);

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title={conversation?.title || (chat.isNew ? t('mobile.chat.new_chat', 'New chat') : t('mobile.chat.title', 'Chat'))}
                // Only while streaming, and only in words: what a person wants
                // to know is that it is still going, not the server's stage.
                subtitle={stream.streaming ? t('mobile.chat.working', 'Working on it…') : undefined}
                onPressTitle={conversationId ? openDetails : undefined}
                titleHint={t('mobile.chat.details_hint', "Opens this conversation's details")}
                actions={
                    <IconButton
                        icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={t('mobile.chat.options', 'Conversation options')}
                        onPress={() => (conversationId ? openDetails() : toast(t('mobile.chat.send_first', 'Send a message first')))}
                    />
                }
            />

            {/* Only with nothing to show: a new chat's id arrives with its
                first answer, and the fetch that follows must not hide it. */}
            {query.isLoading && conversationId && chat.messages.length === 0 ? (
                <LoadingState />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : chat.messages.length === 0 ? (
                // Nothing: an empty thread is the composer and the space above
                // it, which is what the web shows.
                <View style={styles.empty} />
            ) : (
                <ChatTranscript messages={chat.messages} store={stream.store} actions={surface.actions} />
            )}

            <TurnNotices store={stream.store} onResolveDlp={stream.resolveDlp} />

            <Composer
                onSend={chat.handleSend}
                memory={memory}
                onStop={stream.stop}
                streaming={stream.streaming}
                settings={composer.settings}
                onSettingsChange={composer.onSettingsChange}
                tiers={composer.tiers}
                knowledgeBaseNames={composer.knowledgeBaseNames}
                onVoice={openVoice}
                // The server could not open this conversation's history with
                // this session's key: nothing it answers can be saved.
                disabledReason={chat.locked ? t('mobile.chat.history_locked', 'This conversation cannot be continued on this device: its history could not be unlocked.') : undefined}
                initialText={shared.text}
                initialAttachments={shared.attachments}
                extras={surface.extras}
            />
        </Screen>
    );
}

const styles = StyleSheet.create({
    empty: { flex: 1 },
});
