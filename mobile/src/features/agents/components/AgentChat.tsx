/**
 * Chatting with an agent.
 *
 * The transcript, the composer and the streaming turn — everything below the
 * screen's header. Split out of app/agents/[id].tsx because that route renders
 * two quite different things (the agent's profile, and this), and a single
 * file that did both would be mostly ternaries.
 *
 * Structurally this mirrors app/chat/[id].tsx: an inverted FlatList so the
 * newest message sits at the natural scroll position and keyboard resizes keep
 * it pinned, plus a local message list layered over the persisted one so a
 * just-sent message appears before the server has confirmed it.
 *
 * The agent-specific parts:
 *
 *   - Starter prompts. `starter_prompts` is the agent author's answer to "what
 *     do I even ask this thing", and an empty agent chat without them is a
 *     blank box with no affordance.
 *
 *   - A 403 mid-conversation. Agent access is re-read from the database on
 *     EVERY send (server/routes/agents/chat.js), so a revoked group membership
 *     fails the next message while the agent is still on screen. It is shown
 *     as a permanent banner with no retry, because retrying cannot help.
 *
 *   - No tier picker by default. An agent is configured with its own model;
 *     the web client only sends `modelTier` when the user deliberately
 *     overrides it, and so does this.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';

import { AgentAvatar } from './AgentAvatar';
import { useTheme } from '../../../theme/ThemeProvider';
import { Chip } from '../../../ui/Badge';
import { Banner, ErrorState, ListSkeleton } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';
import { encodeAttachments, toWire } from '../../chat/attachments';
import { Composer, type ComposerSettings } from '../../chat/Composer';
import { DlpPrompt } from '../../chat/DlpPrompt';
import { MessageBubble } from '../../chat/MessageBubble';
import type { Attachment, ChatMessage } from '../../chat/types';
import { agentKeys, getAgentConversation, parseStarterPrompts } from '../api';
import { pickAgentAvatar } from '../avatar';
import type { Agent } from '../types';
import { useAgentChatStream } from '../useAgentChatStream';


const DEFAULT_SETTINGS: ComposerSettings = {
    // `auto` here means "leave the model to the agent": it is the sentinel this
    // component checks before deciding whether to send `modelTier` at all.
    modelTier: 'auto',
    // An agent's knowledge is configured server-side, so there is nothing
    // for this surface to attach — see `sources` on ComposerProps.
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: true,
};

export function AgentChat({
    agent,
    conversationId,
    onConversationId,
    initialText = '',
}: {
    agent: Agent;
    /** Null for a chat that has not been created server-side yet. */
    conversationId: string | null;
    /** Called once the server assigns an id, so the route can keep it. */
    onConversationId: (id: string) => void;
    /** Seeded from a starter prompt tapped on the agent's profile. */
    initialText?: string;
}) {
    const theme = useTheme();
    const queryClient = useQueryClient();

    const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
    /** Messages added this session, ahead of the server round-trip. */
    const [local, setLocal] = useState<ChatMessage[]>([]);

    const starters = useMemo(() => parseStarterPrompts(agent.starter_prompts), [agent.starter_prompts]);

    const query = useQuery({
        queryKey: agentKeys.conversation(agent.id, conversationId ?? 'new'),
        queryFn: ({ signal }) => getAgentConversation(agent.id, conversationId as string, signal),
        enabled: Boolean(conversationId),
    });

    const { turn, streaming, send, stop, resolveDlp } = useAgentChatStream({
        agentId: agent.id,
        onDone: (finished) => {
            if (finished.conversationId && !conversationId) {
                onConversationId(finished.conversationId);
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
                              // A turn that produced nothing and reported
                              // nothing was cut off — by the user, or by the
                              // phone leaving the network mid-answer.
                              interrupted:
                                  !finished.error && !finished.accessDenied && !finished.text
                                      ? true
                                      : undefined,
                          }
                        : m,
                ),
            );
            // The server is the source of truth for what was actually stored,
            // including tool messages the stream did not carry.
            void queryClient.invalidateQueries({ queryKey: agentKeys.conversations(agent.id) });
            void queryClient.invalidateQueries({ queryKey: agentKeys.allConversations });
            if (finished.conversationId) {
                void queryClient.invalidateQueries({
                    queryKey: agentKeys.conversation(agent.id, finished.conversationId),
                });
            }
        },
        onUnhandled: (event) => {
            // Not a crash — the server grew a feature this client does not draw
            // yet. Visible in dev, silent in release.
            if (__DEV__) console.warn(`[agents] unhandled SSE event: ${event}`);
        },
    });

    /** Persisted transcript plus anything the server has not confirmed. Reversed for the inverted list. */
    const messages = useMemo(() => {
        const persisted = query.data?.messages ?? [];
        const seen = new Set(persisted.map((m) => m.id));
        const merged = [...persisted, ...local.filter((m) => !seen.has(m.id))];
        return merged.slice().reverse();
    }, [query.data, local]);

    // Byte-identical to the chat screen's, and for the same reason: the dedupe
    // above can never match, because local ids are client UUIDs and persisted
    // ids are the server's, so every turn would render twice from the moment
    // the refetch lands. See app/chat/[id].tsx for the full note.
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
                .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

            setLocal((prev) => [...prev, userMessage, assistantPlaceholder]);

            void (async () => {
                let wire;
                try {
                    // Attachments ride INLINE in the turn body as base64 data
                    // URLs — there is no upload endpoint for chat — so the set
                    // is encoded and size-checked here, before anything is
                    // sent, rather than blowing the 20 MB body limit silently.
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
                    attachments: wire,
                    memoryWriteEnabled: true,
                    webSearchEnabled: settings.webSearchEnabled,
                    // History rule, from agent-hub's useChatEngine: send it only
                    // for a brand-new conversation. For a persisted one the
                    // server reads conversation_messages, which is the durable
                    // copy and avoids drift.
                    ...(conversationId ? {} : { history: priorHistory }),
                    // Omitted unless overridden — the agent's own configured
                    // model is the point of an agent.
                    ...(settings.modelTier !== 'auto' ? { modelTier: settings.modelTier } : {}),
                    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
            })();
        },
        [conversationId, local, send, settings],
    );

    const renderItem = useCallback(
        ({ item }: { item: ChatMessage }) => (
            <MessageBubble
                message={item}
                streamingText={item.streaming ? turn.text : undefined}
                // The agent id and name ride along so the dashboard can rank
                // agents by rating without joining back through the usage log.
                feedback={{
                    conversationId,
                    agentId: agent.id,
                    agentName: agent.name,
                    source: 'agent',
                }}
            />
        ),
        [turn.text, conversationId, agent.id, agent.name],
    );

    return (
        <>
            {turn.accessDenied ? (
                <Banner tone="error" icon="lock">
                    You no longer have access to {agent.name}. Your permissions changed while this
                    chat was open — ask an administrator if you still need it.
                </Banner>
            ) : null}

            {query.isLoading && conversationId ? (
                <ListSkeleton rows={4} />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : messages.length === 0 ? (
                <EmptyAgentChat agent={agent} starters={starters} onPick={(p) => handleSend(p, [])} />
            ) : (
                <FlatList
                    data={messages}
                    keyExtractor={(m) => m.id}
                    renderItem={renderItem}
                    inverted
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingVertical: theme.spacing.lg }}
                    initialNumToRender={12}
                    maxToRenderPerBatch={8}
                    windowSize={11}
                    removeClippedSubviews
                />
            )}

            {/* The stream is HELD OPEN until this is answered; without it the
                turn looks like a hang with no error. */}
            {turn.dlpDecision ? (
                <DlpPrompt decision={turn.dlpDecision} onChoose={resolveDlp} />
            ) : null}

            {turn.phase && streaming ? (
                <Text
                    variant="caption"
                    tone="tertiary"
                    numberOfLines={1}
                    style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs }}
                >
                    {turn.phase}
                </Text>
            ) : null}

            {turn.blocked ? (
                <View style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
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
                // The tier row stays empty on purpose: overriding an agent's
                // model is a desktop-shaped decision, and offering it here
                // invites people to break an agent that was tuned for one.
                tiers={{}}
                sources={false}
                disabledReason={
                    turn.accessDenied ? 'You no longer have access to this agent.' : undefined
                }
                placeholder={`Message ${agent.name}`}
                initialText={initialText}
            />
        </>
    );
}

/**
 * The zero state. The agent's own starter prompts are the affordance; without
 * them this is a blank box, which is the state this whole component exists to
 * avoid.
 */
function EmptyAgentChat({
    agent,
    starters,
    onPick,
}: {
    agent: Agent;
    starters: string[];
    onPick: (prompt: string) => void;
}) {
    const theme = useTheme();
    return (
        <ScrollView
            contentContainerStyle={{
                flexGrow: 1,
                alignItems: 'center',
                justifyContent: 'center',
                padding: theme.spacing.xl,
                gap: theme.spacing.md,
            }}
            keyboardShouldPersistTaps="handled"
        >
            <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={64} />
            <Text variant="heading" center>
                {agent.name}
            </Text>
            {agent.description ? (
                <Text variant="body" tone="tertiary" center>
                    {agent.description}
                </Text>
            ) : null}
            {starters.length > 0 ? (
                <View style={{ gap: theme.spacing.sm, width: '100%', marginTop: theme.spacing.md }}>
                    {starters.slice(0, 4).map((prompt) => (
                        <Chip
                            key={prompt}
                            label={prompt}
                            onPress={() => onPick(prompt)}
                            style={{ alignSelf: 'stretch', justifyContent: 'center' }}
                        />
                    ))}
                </View>
            ) : null}
        </ScrollView>
    );
}
