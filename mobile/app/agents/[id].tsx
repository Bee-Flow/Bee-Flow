/**
 * One agent: its profile, and the conversation you have with it.
 *
 * Both live on this route, keyed off the `c` search param:
 *
 *   /agents/<id>              the profile — what this thing is for
 *   /agents/<id>?c=new        a fresh conversation
 *   /agents/<id>?c=<convId>   an existing one
 *
 * One route rather than two because the transition from profile to chat is a
 * push the user will make and immediately reverse ("what does this do again?"),
 * and because a new conversation has no id until the server answers — routing
 * on the id would mean navigating mid-stream, which is exactly when a screen
 * swap is most disruptive. `?c=new` is also what makes the back button do the
 * obvious thing: chat → profile → list.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import {
    agentKeys,
    getAgent,
    listAgentConversations,
    listAgentTools,
    listComponents,
    listFavorites,
    parseStarterPrompts,
    setFavorite,
    toolLabel,
} from '../../src/features/agents/api';
import { pickAgentAvatar } from '../../src/features/agents/avatar';
import { AgentAvatar } from '../../src/features/agents/components/AgentAvatar';
import { AgentChat } from '../../src/features/agents/components/AgentChat';
import type { Agent } from '../../src/features/agents/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { ErrorState, LoadingState } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';


export default function AgentScreen() {
    const { id, c, q } = useLocalSearchParams<{ id: string; c?: string; q?: string }>();
    const theme = useTheme();
    const router = useRouter();

    /**
     * The conversation this screen is on. Seeded from the route and then owned
     * locally, because the server assigns the id for a new chat mid-stream and
     * rewriting the URL at that moment would remount the screen.
     */
    const [conversationId, setConversationId] = useState<string | null>(
        c && c !== 'new' ? c : null,
    );
    const chatting = Boolean(c);

    const query = useQuery({
        queryKey: agentKeys.detail(id),
        queryFn: ({ signal }) => getAgent(id, signal),
        enabled: Boolean(id),
    });

    const agent = query.data ?? null;

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard={chatting}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title={agent?.name ?? 'Agent'}
                // In chat, the header is the way back to the profile. On the
                // profile it is inert, so it does not look like a dead link.
                onPressTitle={chatting ? () => router.push(`/agents/${id}`) : undefined}
                titleHint={chatting ? "Opens this agent's profile" : undefined}
                leading={
                    chatting && agent ? (
                        <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={28} />
                    ) : null
                }
                actions={
                    agent ? (
                        <IconButton
                            icon={
                                <Feather
                                    name="message-square"
                                    size={20}
                                    color={theme.colors.textPrimary}
                                />
                            }
                            accessibilityLabel={`Conversations with ${agent.name}`}
                            onPress={() => router.push(`/agents/${id}/conversations`)}
                        />
                    ) : null
                }
            />

            {query.isLoading ? (
                <LoadingState />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : !agent ? (
                // GET /agents/:id answers 404 for an agent that exists but is
                // out of reach, so "not found" and "not yours" are the same
                // response by design — do not promise the user a way in.
                <ErrorState
                    error={new Error('This agent is not available to you.')}
                    onRetry={() => void query.refetch()}
                />
            ) : chatting ? (
                <AgentChat
                    agent={agent}
                    conversationId={conversationId}
                    onConversationId={setConversationId}
                    initialText={q ?? ''}
                />
            ) : (
                <AgentProfile
                    agent={agent}
                    onChat={(prompt) =>
                        router.push(
                            prompt
                                ? `/agents/${id}?c=new&q=${encodeURIComponent(prompt)}`
                                : `/agents/${id}?c=new`,
                        )
                    }
                    onOpenConversation={(convId) => router.push(`/agents/${id}?c=${convId}`)}
                    onSeeAllConversations={() => router.push(`/agents/${id}/conversations`)}
                />
            )}
        </Screen>
    );
}

function AgentProfile({
    agent,
    onChat,
    onOpenConversation,
    onSeeAllConversations,
}: {
    agent: Agent;
    /** An empty prompt starts a blank chat; a starter seeds the composer. */
    onChat: (prompt?: string) => void;
    onOpenConversation: (conversationId: string) => void;
    onSeeAllConversations: () => void;
}) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const starters = useMemo(
        () => parseStarterPrompts(agent.starter_prompts),
        [agent.starter_prompts],
    );

    // Tools come from the dedicated endpoint rather than `agent.tools`: it is
    // the one that is visibility-gated the same way the detail is, and it is
    // the shape the fixed params arrive in.
    const tools = useQuery({
        queryKey: agentKeys.tools(agent.id),
        queryFn: ({ signal }) => listAgentTools(agent.id, signal),
    });

    // The catalogue turns `web-search` into "Web Search". It is org-wide and
    // effectively static, so it is cached hard and never blocks the screen.
    const components = useQuery({
        queryKey: agentKeys.components,
        queryFn: ({ signal }) => listComponents(signal),
        staleTime: 30 * 60_000,
    });

    const conversations = useQuery({
        queryKey: agentKeys.conversations(agent.id),
        queryFn: ({ signal }) => listAgentConversations(agent.id, signal),
    });

    const favorites = useQuery({
        queryKey: agentKeys.favorites,
        queryFn: ({ signal }) => listFavorites(signal),
    });
    const isFavorite = (favorites.data ?? []).includes(agent.id);

    const toggleFavorite = useMutation({
        mutationFn: () => setFavorite(agent.id, !isFavorite),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: agentKeys.favorites });
            const previous = queryClient.getQueryData<string[]>(agentKeys.favorites) ?? [];
            queryClient.setQueryData<string[]>(
                agentKeys.favorites,
                isFavorite ? previous.filter((v) => v !== agent.id) : [...previous, agent.id],
            );
            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) queryClient.setQueryData(agentKeys.favorites, context.previous);
            toast('That favourite did not save', 'error');
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.favorites });
        },
    });

    const knowledgeCount = agent.config.knowledge_base_ids?.length ?? 0;
    const skillCount = agent.config.attachedSkillIds?.length ?? 0;
    const recent = (conversations.data ?? []).slice(0, 3);

    return (
        <ScrollView
            contentContainerStyle={{
                padding: theme.spacing.lg,
                paddingBottom: theme.spacing.xxxl,
                gap: theme.spacing.xl,
            }}
        >
            <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
                <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={72} />
                <Text variant="title" center>
                    {agent.name}
                </Text>
                {agent.description ? (
                    <Text variant="body" tone="tertiary" center>
                        {agent.description}
                    </Text>
                ) : null}
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    {agent.is_published ? (
                        <Badge label="Shared with your organisation" tone="accent" />
                    ) : (
                        <Badge label="Private to you" />
                    )}
                    {agent.config.strictKnowledge ? <Badge label="Knowledge only" /> : null}
                </View>
            </View>

            <View style={{ gap: theme.spacing.sm }}>
                <Button
                    label="Chat with this agent"
                    onPress={() => onChat()}
                    size="lg"
                    fullWidth
                    icon={
                        <Feather name="message-square" size={18} color={theme.colors.accentPrimaryFg} />
                    }
                    accessibilityHint={`Starts a new conversation with ${agent.name}`}
                />
                <Button
                    label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                    onPress={() => toggleFavorite.mutate()}
                    variant="secondary"
                    fullWidth
                    icon={
                        <Feather
                            name="star"
                            size={18}
                            color={isFavorite ? theme.colors.warning : theme.colors.textSecondary}
                        />
                    }
                />
            </View>

            {starters.length > 0 ? (
                <Section title="Try asking" subtitle="Written by whoever built this agent">
                    <View style={{ gap: theme.spacing.sm }}>
                        {starters.map((prompt) => (
                            <Chip
                                key={prompt}
                                label={prompt}
                                onPress={() => onChat(prompt)}
                                style={{ alignSelf: 'stretch', justifyContent: 'center' }}
                            />
                        ))}
                    </View>
                </Section>
            ) : null}

            <Section
                title="What it can use"
                subtitle="Tools and knowledge this agent reaches for on its own"
            >
                <Card padded={false}>
                    {(tools.data ?? []).length === 0 && knowledgeCount === 0 && skillCount === 0 ? (
                        <ListRow
                            title="Just the model"
                            subtitle="No tools or knowledge bases are attached — it answers from what the model knows plus what you send it."
                        />
                    ) : (
                        <>
                            {(tools.data ?? []).map((tool, index) => (
                                <React.Fragment key={tool.componentId}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ListRow
                                        title={toolLabel(tool.componentId, components.data ?? [])}
                                        // Never render the params themselves:
                                        // fixed tool params routinely hold API
                                        // keys and customer-specific config.
                                        subtitle={
                                            tool.params && Object.keys(tool.params).length > 0
                                                ? 'Pre-configured by the agent’s author'
                                                : undefined
                                        }
                                        leading={
                                            <Feather
                                                name="tool"
                                                size={18}
                                                color={theme.colors.textMuted}
                                            />
                                        }
                                    />
                                </React.Fragment>
                            ))}
                            {knowledgeCount > 0 ? (
                                <>
                                    {(tools.data ?? []).length > 0 ? (
                                        <Divider inset={theme.spacing.lg} />
                                    ) : null}
                                    <ListRow
                                        title={
                                            knowledgeCount === 1
                                                ? '1 knowledge base'
                                                : `${knowledgeCount} knowledge bases`
                                        }
                                        subtitle={
                                            agent.config.strictKnowledge
                                                ? 'It answers only from these, and says so when it cannot.'
                                                : 'Searched first, then combined with what the model knows.'
                                        }
                                        leading={
                                            <Feather
                                                name="book-open"
                                                size={18}
                                                color={theme.colors.textMuted}
                                            />
                                        }
                                    />
                                </>
                            ) : null}
                            {skillCount > 0 ? (
                                <>
                                    <Divider inset={theme.spacing.lg} />
                                    <ListRow
                                        title={skillCount === 1 ? '1 skill' : `${skillCount} skills`}
                                        subtitle="Extra instructions loaded when they are relevant."
                                        leading={
                                            <Feather
                                                name="zap"
                                                size={18}
                                                color={theme.colors.textMuted}
                                            />
                                        }
                                    />
                                </>
                            ) : null}
                        </>
                    )}
                </Card>
            </Section>

            {recent.length > 0 ? (
                <Section
                    title="Your conversations"
                    action={
                        <Pressable
                            onPress={onSeeAllConversations}
                            accessibilityRole="button"
                            accessibilityLabel="See all conversations with this agent"
                            hitSlop={theme.hitSlop}
                        >
                            <Text variant="caption" tone="accent">
                                See all
                            </Text>
                        </Pressable>
                    }
                >
                    <Card padded={false}>
                        {recent.map((conversation, index) => (
                            <React.Fragment key={conversation.id}>
                                {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={conversation.title || 'Untitled chat'}
                                    meta={relativeTime(conversation.updated_at)}
                                    onPress={() => onOpenConversation(conversation.id)}
                                />
                            </React.Fragment>
                        ))}
                    </Card>
                </Section>
            ) : null}

            <Section title="Details">
                <Card padded={false}>
                    <ListRow
                        title="Model"
                        // `tier:<key>` is a tier, not a model name; showing the
                        // raw string would be meaningless to a reader.
                        subtitle={describeModel(agent.model)}
                        leading={<Feather name="cpu" size={18} color={theme.colors.textMuted} />}
                    />
                    <Divider inset={theme.spacing.lg} />
                    <ListRow
                        title="Guardrails"
                        subtitle={
                            agent.config.enableGuardrails
                                ? 'Responses are screened before you see them.'
                                : 'Not enabled for this agent.'
                        }
                        leading={<Feather name="shield" size={18} color={theme.colors.textMuted} />}
                    />
                    {agent.updated_at ? (
                        <>
                            <Divider inset={theme.spacing.lg} />
                            <ListRow
                                title="Last changed"
                                subtitle={relativeTime(agent.updated_at)}
                                leading={
                                    <Feather name="clock" size={18} color={theme.colors.textMuted} />
                                }
                            />
                        </>
                    ) : null}
                </Card>
                {agent.can_edit ? (
                    <Text variant="caption" tone="tertiary">
                        You can edit this agent in the Agent Designer on the desktop. Editing is not
                        available on the phone yet.
                    </Text>
                ) : null}
            </Section>
        </ScrollView>
    );
}

function describeModel(model: string | null): string {
    if (!model) return 'Your organisation’s default';
    if (model.startsWith('tier:')) {
        const tier = model.slice('tier:'.length).replace(/^custom:/, '').replace(/[-_]+/g, ' ');
        return `Chosen per message — ${tier} tier`;
    }
    return model;
}
