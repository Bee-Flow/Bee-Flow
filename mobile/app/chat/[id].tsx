/**
 * The conversation screen.
 *
 * `id` is either a conversation id or the literal `new`. Routing a new chat
 * through the same screen (rather than a separate one) means the transition
 * from "empty" to "has an id" is a state change instead of a navigation —
 * so the first answer does not get interrupted by a screen swap, which is
 * exactly when it would be most annoying.
 *
 * The transcript is an inverted FlatList. Inverted because a chat is read from
 * the bottom: it puts the newest message at the natural scroll position with
 * no scrollToEnd on every token, and it means keyboard-driven resizes keep the
 * latest message pinned rather than jumping.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';

import { chatKeys, getConversation } from '../../src/features/chat/api';
import { encodeAttachments, toWire } from '../../src/features/chat/attachments';
import { Composer, type ComposerSettings } from '../../src/features/chat/Composer';
import { DlpPrompt } from '../../src/features/chat/DlpPrompt';
import { MessageBubble } from '../../src/features/chat/MessageBubble';
import {
    setChatPreferences,
    useChatPreferences,
} from '../../src/features/chat/settingsStore';
import { SwarmPanel } from '../../src/features/chat/SwarmPanel';
import { fetchTiers, reconcileTier, tierKeys } from '../../src/features/chat/tiers';
import type { Attachment, ChatMessage, ReasoningEffort } from '../../src/features/chat/types';
import { useChatStream } from '../../src/features/chat/useChatStream';
import { libraryKeys, listKnowledgeBases } from '../../src/features/library/api';
import {
    consumePendingShare,
    describeSharedPayload,
} from '../../src/features/search/shareIntent';
import { useActiveSkills } from '../../src/features/skills/active';
import { useTheme } from '../../src/theme/ThemeProvider';
import { IconButton } from '../../src/ui/Button';
import { ErrorState, LoadingState } from '../../src/ui/Feedback';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function ChatScreen() {
    const { id, kb, draft } = useLocalSearchParams<{ id: string; kb?: string; draft?: string }>();
    const isNew = !id || id === 'new';
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [conversationId, setConversationId] = useState<string | null>(isNew ? null : id);

    /**
     * The composer's settings are split by lifetime, not by screen.
     *
     * `modelTier` and `webSearchEnabled` are a standing preference and live in
     * the persisted store — they used to be plain state here, so every new
     * chat silently reset them and someone who had deliberately switched web
     * search off got it back on without being told.
     *
     * `knowledgeBaseIds` and `reasoningEffort` belong to THIS conversation:
     * which sources to read is a per-chat decision, and how hard to think is a
     * per-question one that must never be remembered (a stored "high" would
     * quietly spend the user's allowance on every trivial question after it).
     */
    const prefs = useChatPreferences();
    const { activeSkillIds } = useActiveSkills();
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
    /** Seeded by "Ask about this" on a knowledge base, which routes with ?kb=. */
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>(() => (kb ? [kb] : []));

    // Memoised because `handleSend` depends on it, and this is the screen
    // where a wasted re-render is most expensive — a transcript of markdown
    // rebuilding on every keystroke in the composer.
    const settings: ComposerSettings = useMemo(
        () => ({
            modelTier: prefs.modelTier,
            webSearchEnabled: prefs.webSearchEnabled,
            reasoningEffort,
            knowledgeBaseIds,
        }),
        [prefs.modelTier, prefs.webSearchEnabled, reasoningEffort, knowledgeBaseIds],
    );
    const handleSettingsChange = useCallback((next: ComposerSettings) => {
        setReasoningEffort(next.reasoningEffort);
        setKnowledgeBaseIds(next.knowledgeBaseIds);
        setChatPreferences({
            modelTier: next.modelTier,
            webSearchEnabled: next.webSearchEnabled,
        });
    }, []);

    // Names for the attached chips. Shares a key with the ＋ sheet's query, so
    // React Query fetches the list once however many places ask for it, and
    // only when something is actually attached.
    const baseNames = useQuery({
        queryKey: libraryKeys.knowledgeBases,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
        enabled: knowledgeBaseIds.length > 0,
        staleTime: 5 * 60_000,
    });
    /**
     * Text and files handed over by Android's share sheet.
     *
     * Drained ONCE, on mount, and only into a new chat. `consumePendingShare`
     * clears the staged payload as it returns it, so a re-render cannot
     * re-attach the same file and navigating away cannot leave it to reappear
     * in an unrelated conversation later.
     */
    const [shared] = useState(() => (isNew ? consumePendingShare() : null));
    // The tier dial's brain icon — the web parks the memory switch in that
    // panel because both settings answer "how much does the assistant bring
    // to the next turn?". Per conversation, not persisted: pausing memory is
    // a decision about what you are about to say, not a standing preference.
    const [memoryEnabled, setMemoryEnabled] = useState(true);
    const sharedContent = shared ? describeSharedPayload(shared) : null;
    /** Messages added this session, ahead of the server round-trip. */
    const [local, setLocal] = useState<ChatMessage[]>([]);
    const listRef = useRef<FlatList<ChatMessage>>(null);

    const tiersQuery = useQuery({
        queryKey: tierKeys.forTask('direct_chat'),
        queryFn: ({ signal }) => fetchTiers('direct_chat', signal),
        // Entitlements change rarely and a refetch mid-conversation would
        // reshuffle the tier row under the user's thumb.
        staleTime: 10 * 60_000,
    });

    // A remembered tier can vanish between sessions — a beta flag switched off,
    // a group changed, a custom tier deleted — and sending one the server will
    // not accept fails the turn with an error the user cannot act on.
    useEffect(() => {
        if (!tiersQuery.data || !prefs.ready) return;
        const resolved = reconcileTier(prefs.modelTier, tiersQuery.data);
        if (resolved !== prefs.modelTier) setChatPreferences({ modelTier: resolved });
    }, [tiersQuery.data, prefs.modelTier, prefs.ready]);

    const query = useQuery({
        queryKey: chatKeys.conversation(conversationId ?? 'new'),
        queryFn: ({ signal }) => getConversation(conversationId as string, signal),
        enabled: Boolean(conversationId),
    });

    const { turn, streaming, send, stop, resolveDlp } = useChatStream({
        onDone: (finished) => {
            // The server assigns the id on the first turn of a new chat. It
            // usually arrives mid-stream on `conversation_created`, but this
            // covers a turn that only reported it at the end.
            if (finished.conversationId && !conversationId) {
                setConversationId(finished.conversationId);
            }
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
                              images: finished.images,
                              error: finished.error ?? undefined,
                              interrupted: !finished.error && !finished.text ? true : undefined,
                          }
                        : m,
                ),
            );
            // Re-read the persisted transcript: the server is the source of
            // truth for what was actually stored, including any tool messages
            // the stream did not carry.
            void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
            if (finished.conversationId) {
                void queryClient.invalidateQueries({
                    queryKey: chatKeys.conversation(finished.conversationId),
                });
            }
        },
        onUnhandled: (event) => {
            // Not a crash — the server grew a feature this client does not draw
            // yet. Visible in dev, silent in release.
            if (__DEV__) console.warn(`[chat] unhandled SSE event: ${event}`);
        },
    });

    /**
     * The rendered transcript: whatever the server has, plus anything added
     * locally that the server has not confirmed yet. Reversed, because the
     * list is inverted.
     */
    const messages = useMemo(() => {
        const persisted = query.data?.messages ?? [];
        const seen = new Set(persisted.map((m) => m.id));
        const merged = [...persisted, ...local.filter((m) => !seen.has(m.id))];
        return merged.slice().reverse();
    }, [query.data, local]);

    /**
     * Hand the transcript back to the server once it has caught up.
     *
     * The merge above dedupes by id, and it can never match: local ids are
     * `Crypto.randomUUID()` and persisted ids are the server's. So without
     * this, every turn stays in `local` for the life of the screen and the
     * refetch that follows `onDone` renders the whole conversation TWICE.
     *
     * Keyed on `dataUpdatedAt` rather than on `data`: it changes on every
     * successful fetch, including one that returned an identical body, which
     * is exactly the "the server has it now" signal. Held back while a turn is
     * streaming, because dropping the local placeholder mid-stream would blank
     * the answer being written.
     */
    const persistedAt = query.dataUpdatedAt;
    useEffect(() => {
        if (!persistedAt || streaming) return;
        setLocal((prev) => (prev.length ? [] : prev));
    }, [persistedAt, streaming]);

    const handleSend = useCallback(
        (text: string, attachments: Attachment[]) => {
            const userMessage: ChatMessage = {
                id: Crypto.randomUUID(),
                role: 'user',
                content: text,
                attachments,
                createdAt: new Date().toISOString(),
            };
            const assistantPlaceholder: ChatMessage = {
                id: Crypto.randomUUID(),
                role: 'assistant',
                content: '',
                streaming: true,
            };
            const priorHistory = local
                .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
                .map((m) => ({ role: m.role, content: m.content }));

            setLocal((prev) => [...prev, userMessage, assistantPlaceholder]);

            void (async () => {
                let wire;
                try {
                    // Attachments ride INLINE in the turn body as base64 data
                    // URLs — there is no upload endpoint for chat — so images
                    // are resized and the whole set is size-checked here,
                    // before anything is sent. A rejected attachment must fail
                    // loudly rather than silently blowing the 20 MB body limit.
                    wire = toWire(await encodeAttachments(attachments));
                } catch (err) {
                    setLocal((prev) =>
                        prev.map((m) =>
                            m.id === assistantPlaceholder.id
                                ? { ...m, streaming: false, error: (err as Error).message }
                                : m,
                        ),
                    );
                    return;
                }

                await send({
                    message: text,
                    conversationId: conversationId ?? undefined,
                    modelTier: settings.modelTier,
                    attachments: wire,
                    // History rule, from agent-hub's useChatEngine: send it only
                    // for a brand-new conversation (or an edit/retry). For a
                    // persisted one the server reads conversation_messages,
                    // which is the durable copy and avoids drift.
                    history: conversationId ? undefined : priorHistory,
                    webSearchEnabled: settings.webSearchEnabled,
                    memoryWriteEnabled: memoryEnabled,
                    // Both of these were declared on SendTurnPayload and never
                    // once assigned. streamTurn.js has been destructuring them
                    // the whole time, with access-validated KB retrieval in
                    // promptAssembly.js and skill injection in the tool stack —
                    // so until now a document in a knowledge base could not be
                    // asked about anywhere in this app, and the Skills screen's
                    // "N switched on for new chats" was untrue.
                    ...(settings.knowledgeBaseIds.length
                        ? { knowledgeBaseIds: settings.knowledgeBaseIds }
                        : {}),
                    ...(activeSkillIds.length ? { activeSkillIds: [...activeSkillIds] } : {}),
                    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
            })();
        },
        [conversationId, local, send, settings, activeSkillIds, memoryEnabled],
    );

    /**
     * The draft handed over by the Chat tab's composer.
     *
     * The home screen is a composer now, so sending from it has to continue
     * here rather than re-implement the turn loop. Sent once, on mount, guarded
     * by a ref: expo-router keeps the param around, so a re-render — or a
     * back-and-forward — would otherwise send it again.
     */
    const draftSent = useRef(false);
    useEffect(() => {
        if (draftSent.current || !draft || !isNew) return;
        draftSent.current = true;
        handleSend(draft, []);
    }, [draft, isNew, handleSend]);

    const renderItem = useCallback(
        ({ item }: { item: ChatMessage }) => (
            <MessageBubble
                message={item}
                streamingText={item.streaming ? turn.text : undefined}
                // 'direct', not the server's default of 'agent': the operator
                // dashboard groups feedback on this string, and filing direct
                // chats under agents would misattribute every rating here.
                feedback={{ conversationId, source: 'direct' }}
            />
        ),
        [turn.text, conversationId],
    );

    const title = query.data?.title || (isNew ? 'New chat' : 'Chat');

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title={title}
                // Only while streaming, and only in words. `turn.phase` is a
                // server-side stage name and `turn.modelId` is an API string
                // like `claude-opus-5`; joining them with a middot produced a
                // subtitle that told the user nothing they could act on and
                // implied a fault when it read oddly. What a person wants to
                // know here is simply that it is still going.
                subtitle={streaming ? 'Working on it…' : undefined}
                onPressTitle={
                    conversationId
                        ? () => router.push(`/chat/${conversationId}/details`)
                        : undefined
                }
                titleHint="Opens this conversation's details"
                actions={
                    <IconButton
                        icon={
                            <Feather
                                name="more-vertical"
                                size={20}
                                color={theme.colors.textPrimary}
                            />
                        }
                        accessibilityLabel="Conversation options"
                        onPress={() =>
                            conversationId
                                ? router.push(`/chat/${conversationId}/details`)
                                : toast('Send a message first')
                        }
                    />
                }
            />

            {query.isLoading && conversationId ? (
                <LoadingState />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : messages.length === 0 ? (
                /*
                 * Nothing. An empty thread is the composer and the space above
                 * it, which is what the web shows and what this screen is now:
                 * the tile-and-subtitle empty state that used to sit here was
                 * the phone inventing a home screen the web does not have, and
                 * it is the block in the owner's screenshot. The composer below
                 * already says what to do, in the place you would do it.
                 */
                <View style={{ flex: 1 }} />
            ) : (
                <FlatList
                    ref={listRef}
                    data={messages}
                    keyExtractor={(m) => m.id}
                    renderItem={renderItem}
                    inverted
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingVertical: theme.spacing.lg }}
                    // A long transcript with markdown in every row is the one
                    // place this app can drop frames; these keep the window
                    // tight without making scrolling feel empty.
                    initialNumToRender={12}
                    maxToRenderPerBatch={8}
                    windowSize={11}
                    removeClippedSubviews
                />
            )}

            {turn.swarm ? <SwarmPanel progress={turn.swarm} /> : null}

            {turn.dlpDecision ? (
                <DlpPrompt decision={turn.dlpDecision} onChoose={resolveDlp} />
            ) : null}

            {turn.blocked ? (
                <View
                    style={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingVertical: theme.spacing.sm,
                    }}
                >
                    <Text variant="caption" tone="warning">
                        {turn.blocked.reason}
                        {turn.blocked.detail ? ` ${turn.blocked.detail}` : ''}
                    </Text>
                </View>
            ) : null}

            <Composer
                onSend={handleSend}
                memory={{
                    enabled: memoryEnabled,
                    onToggle: () => setMemoryEnabled((v) => !v),
                }}
                onStop={stop}
                streaming={streaming}
                settings={settings}
                onSettingsChange={handleSettingsChange}
                tiers={tiersQuery.data ?? {}}
                knowledgeBaseNames={baseNames.data ?? []}
                onVoice={() => router.push('/voice')}
                initialText={sharedContent?.text ?? ''}
                initialAttachments={(sharedContent?.files ?? []).map((file) => ({
                    name: file.name,
                    mimeType: file.mimeType,
                    // The share sheet reports null for a size it could not
                    // determine; Attachment treats that as "unknown", and
                    // encodeAttachments measures it after the read.
                    size: file.size ?? undefined,
                    // Already a readable local path; encodeAttachments does the
                    // resize-and-encode at send time like any other pick.
                    uri: file.uri,
                }))}
            />
        </Screen>
    );
}
