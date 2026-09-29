/**
 * Every agent the signed-in user can open.
 *
 * The product is called Agent Hub, so this is the screen it is named after.
 * Two things share it, behind one switch:
 *
 *   - Agents. Merged from `/agents/published` and `/agents` (see api.ts for
 *     why both), searched locally because the list is small — tens of rows,
 *     not thousands — and a round-trip per keystroke on a phone network is
 *     slower than the filter it replaces.
 *
 *   - Recent chats. `/agents/conversations/all`, which is the only way to get
 *     back to a conversation whose agent you cannot remember. The server caps
 *     it at 50 rows with no cursor, so it is labelled "recent" rather than
 *     offered as a full history.
 *
 * Favourites are DB-backed (`/agents/favorites`), not device-local, so the
 * same agents are starred here and on the web. The toggle is optimistic: the
 * star has to move on the tap, and both directions are idempotent server-side,
 * so a lost round-trip costs nothing but a stale star until the next refetch.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';

import {
    agentKeys,
    listAgents,
    listAllConversations,
    listCategories,
    listFavorites,
    setFavorite,
} from '../../src/features/agents/api';
import { AgentAvatar } from '../../src/features/agents/components/AgentAvatar';
import { AgentRow } from '../../src/features/agents/components/AgentRow';
import type { Agent, AgentConversationAcrossAgents } from '../../src/features/agents/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Chip } from '../../src/ui/Badge';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Segmented } from '../../src/ui/Segmented';
import { useToast } from '../../src/ui/Toast';

type Tab = 'agents' | 'chats';

/** `favorites` is not a category id — it is a filter over the same list. */
const FAVORITES = 'favorites';
const ALL = 'all';

export default function AgentsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [tab, setTab] = useState<Tab>('agents');

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="Agents" subtitle="Purpose-built assistants" />

            <View
                style={{
                    flexDirection: 'row',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.sm,
                }}
            >
                {/* Was two Chips — a MULTI-select control announcing itself as
                    buttons for a choice where exactly one can be on. */}
                <Segmented
                    accessibilityLabel="Agents or recent chats"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'agents', label: 'Agents' },
                        { value: 'chats', label: 'Recent chats' },
                    ]}
                />
            </View>

            {tab === 'agents' ? (
                <AgentList onOpen={(id) => router.push(`/agents/${id}`)} />
            ) : (
                <RecentChats
                    onOpen={(conversation) =>
                        router.push(`/agents/${conversation.agent_id}?c=${conversation.id}`)
                    }
                />
            )}
        </Screen>
    );
}

function AgentList({ onOpen }: { onOpen: (id: string) => void }) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<string>(ALL);

    const query = useQuery({
        queryKey: agentKeys.all,
        queryFn: ({ signal }) => listAgents(signal),
    });

    const categories = useQuery({
        queryKey: agentKeys.categories,
        queryFn: ({ signal }) => listCategories(signal),
        // Categories are org configuration; they change on the order of months.
        staleTime: 10 * 60_000,
    });

    const favorites = useQuery({
        queryKey: agentKeys.favorites,
        queryFn: ({ signal }) => listFavorites(signal),
    });

    const favoriteIds = useMemo(() => new Set(favorites.data ?? []), [favorites.data]);

    const toggleFavorite = useMutation({
        mutationFn: ({ id, next }: { id: string; next: boolean }) => setFavorite(id, next),
        onMutate: async ({ id, next }) => {
            await queryClient.cancelQueries({ queryKey: agentKeys.favorites });
            const previous = queryClient.getQueryData<string[]>(agentKeys.favorites) ?? [];
            queryClient.setQueryData<string[]>(
                agentKeys.favorites,
                next ? [...previous, id] : previous.filter((v) => v !== id),
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

    const items = useMemo(
        () => filterAgents(query.data ?? [], search, category, favoriteIds),
        [query.data, search, category, favoriteIds],
    );

    const filtersApplied = search.trim().length > 0 || category !== ALL;

    return (
        <>
            <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search agents" />
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{
                        gap: theme.spacing.sm,
                        paddingVertical: theme.spacing.xs,
                        paddingRight: theme.spacing.lg,
                    }}
                >
                    <Chip label="All" selected={category === ALL} onPress={() => setCategory(ALL)} />
                    <Chip
                        label="Favourites"
                        selected={category === FAVORITES}
                        onPress={() => setCategory(FAVORITES)}
                    />
                    {(categories.data ?? []).map((c) => (
                        <Chip
                            key={c.id}
                            label={c.icon ? `${c.icon} ${c.name}` : c.name}
                            selected={category === c.id}
                            onPress={() => setCategory(c.id)}
                        />
                    ))}
                </ScrollView>
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="cpu"
                    title={filtersApplied ? 'Nothing matches that' : 'No agents yet'}
                    message={
                        filtersApplied
                            ? 'Try another word, or clear the filter.'
                            : 'Agents are built on the desktop, in the Agent Designer. Once one is published to your organisation it appears here.'
                    }
                    actionLabel={filtersApplied ? 'Clear filters' : undefined}
                    onAction={
                        filtersApplied
                            ? () => {
                                  setSearch('');
                                  setCategory(ALL);
                              }
                            : undefined
                    }
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => {
                                void query.refetch();
                                void favorites.refetch();
                            }}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={({ item }) => (
                        <AgentRow
                            agent={item}
                            favorite={favoriteIds.has(item.id)}
                            onPress={() => onOpen(item.id)}
                            onToggleFavorite={() =>
                                toggleFavorite.mutate({
                                    id: item.id,
                                    next: !favoriteIds.has(item.id),
                                })
                            }
                        />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </>
    );
}

function RecentChats({
    onOpen,
}: {
    onOpen: (conversation: AgentConversationAcrossAgents) => void;
}) {
    const theme = useTheme();

    const query = useQuery({
        queryKey: agentKeys.allConversations,
        queryFn: ({ signal }) => listAllConversations(signal),
    });

    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if ((query.data ?? []).length === 0) {
        return (
            <EmptyState
                icon="message-circle"
                title="No agent chats yet"
                message="Open an agent and ask it something — the conversation shows up here afterwards."
            />
        );
    }

    return (
        <FlatList
            data={query.data ?? []}
            keyExtractor={(item) => item.id}
            refreshControl={
                <RefreshControl
                    refreshing={query.isRefetching}
                    onRefresh={() => void query.refetch()}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            renderItem={({ item }) => (
                <ListRow
                    // A conversation whose title generation has not run yet has
                    // none at all; the row still has to be tappable.
                    title={item.title || 'Untitled chat'}
                    subtitle={item.agent_name ?? 'Deleted agent'}
                    meta={relativeTime(item.updated_at)}
                    wrapTitle
                    leading={
                        <AgentAvatar
                            name={item.agent_name ?? 'Agent'}
                            avatar={item.agent_avatar}
                            size={36}
                        />
                    }
                    trailing={
                        item.pinned ? (
                            <Feather name="bookmark" size={16} color={theme.colors.textMuted} />
                        ) : undefined
                    }
                    onPress={() => onOpen(item)}
                />
            )}
            contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
        />
    );
}

function filterAgents(
    agents: Agent[],
    search: string,
    category: string,
    favoriteIds: Set<string>,
): Agent[] {
    const needle = search.trim().toLowerCase();
    return agents.filter((agent) => {
        if (needle) {
            const haystack = `${agent.name} ${agent.description ?? ''}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        if (category === FAVORITES) return favoriteIds.has(agent.id);
        if (category !== ALL) return agent.category_id === category;
        return true;
    });
}
