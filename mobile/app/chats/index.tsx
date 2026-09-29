/**
 * Every conversation.
 *
 * This WAS the Chat tab — the list was the home screen, and starting a chat
 * meant finding the FAB. The tab root is now the composer (see
 * `app/(tabs)/index.tsx`), which is what the web app puts there and what people
 * open the app to do; this list is one tap away behind "All conversations".
 *
 * The grouping code below is unchanged from when it was the home. It was never
 * the problem.
 *
 * Pinned conversations float to the top; everything else is grouped by how
 * recently it moved. Date grouping rather than a flat list because a
 * chronological wall of titles is unreadable past about fifteen rows, and most
 * people have hundreds.
 *
 * AGENT conversations are here too, under their own heading. They used to live
 * only under More → Agents, which meant somebody who talked to an agent
 * yesterday opened the tab labelled Chat, did not find it, and reasonably
 * concluded the app had lost it. The sitemap has always described this tab as
 * "Conversations with your agents"; now that is true.
 *
 * They are a separate SECTION rather than interleaved, and that is deliberate
 * rather than lazy: `/agents/conversations/all` is capped at 50 rows by the
 * server with no cursor, so a merged, sorted list would silently drop older
 * agent chats into a gap it could never explain. An honest heading is uglier
 * and correct.
 *
 * There is no search field here. There used to be, filtering titles on the
 * client — which competed with the real server-side search one icon away in
 * the header, and quietly claimed to have searched conversations it had never
 * loaded.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { RefreshControl, SectionList } from 'react-native';

import { agentKeys, listAllConversations } from '../../src/features/agents/api';
import { AgentAvatar } from '../../src/features/agents/components/AgentAvatar';
import type { AgentConversationAcrossAgents } from '../../src/features/agents/types';
import { chatKeys, listConversations } from '../../src/features/chat/api';
import type { ConversationSummary } from '../../src/features/chat/types';
import { translate, useTranslation } from '../../src/i18n';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function AllConversationsScreen() {
    const theme = useTheme();
    const router = useRouter();

    const query = useQuery({
        queryKey: chatKeys.conversations,
        queryFn: ({ signal }) => listConversations(signal),
    });

    // Agent chats are a nice-to-have on this screen, not its reason for
    // existing, so a failure here must not take the tab down with it — the
    // section simply does not appear.
    const agentChats = useQuery({
        queryKey: agentKeys.allConversations,
        queryFn: ({ signal }) => listAllConversations(signal),
        staleTime: 60_000,
    });

    const t = useTranslation();
    const sections = useMemo(
        () => groupConversations(query.data ?? [], agentChats.data ?? []),
        [query.data, agentChats.data],
    );

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('mobile.chats.title', 'All conversations')} showBack />

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : sections.length === 0 ? (
                <EmptyState
                    icon="message-square"
                    title={t('sidebar.no_chats_yet', 'No chats yet')}
                    message={t(
                        'mobile.chats.empty_message',
                        'Start a conversation and it will appear here, on every device you sign in to.',
                    )}
                    actionLabel={t('sidebar.new_chat', 'New Chat')}
                    onAction={() => router.push('/chat/new')}
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(item) => item.id}
                    stickySectionHeadersEnabled={false}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderSectionHeader={({ section }) => (
                        <Text
                            variant="label"
                            tone="tertiary"
                            style={{
                                paddingHorizontal: theme.spacing.lg,
                                paddingTop: theme.spacing.lg,
                                paddingBottom: theme.spacing.xs,
                            }}
                        >
                            {section.title.toUpperCase()}
                        </Text>
                    )}
                    renderItem={({ item }) =>
                        'agent_id' in item ? (
                            <ListRow
                                title={item.title || t('mobile.chats.untitled', 'Untitled chat')}
                                subtitle={item.agent_name ?? t('chat.composer.agent_fallback', 'Agent')}
                                meta={relativeTime(item.updated_at)}
                                // The same avatar the Agents screen draws, so a
                                // row here is recognisably the same thing as a
                                // row there. `leading` already takes an element.
                                leading={
                                    <AgentAvatar
                                        name={item.agent_name ?? t('chat.composer.agent_fallback', 'Agent')}
                                        avatar={item.agent_avatar}
                                        size={28}
                                    />
                                }
                                onPress={() =>
                                    router.push(
                                        `/agents/${encodeURIComponent(item.agent_id)}?c=${encodeURIComponent(item.id)}`,
                                    )
                                }
                            />
                        ) : (
                            <ListRow
                                title={item.title || t('mobile.chats.untitled', 'Untitled chat')}
                                meta={relativeTime(item.updated_at)}
                                leading={
                                    item.pinned ? (
                                        <Feather
                                            name="bookmark"
                                            size={16}
                                            color={theme.colors.accentText}
                                        />
                                    ) : (
                                        <Feather
                                            name="message-circle"
                                            size={16}
                                            color={theme.colors.textMuted}
                                        />
                                    )
                                }
                                onPress={() => router.push(`/chat/${item.id}`)}
                            />
                        )
                    }
                    contentContainerStyle={{ paddingBottom: 96 }}
                />
            )}

        </Screen>
    );
}

type Row = ConversationSummary | AgentConversationAcrossAgents;

interface Section {
    title: string;
    data: Row[];
}

/**
 * Group by recency, pinned first.
 *
 * The buckets are the ones people actually reason in — today, yesterday, this
 * week, this month, older — rather than exact dates, which nobody remembers
 * about a chat.
 */
type BucketId = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'older';

/**
 * The web's own headings where it has them. `sidebar.*` is the browser's chat
 * list — same subject, and the More tab already borrows from it — so an
 * administrator who translated one client has translated both.
 */
function bucketTitle(bucket: BucketId): string {
    switch (bucket) {
        case 'today':
            return translate('sidebar.today', 'Today');
        case 'yesterday':
            return translate('sidebar.yesterday', 'Yesterday');
        case 'this_week':
            return translate('mobile.chats.this_week', 'This week');
        case 'this_month':
            return translate('mobile.chats.this_month', 'This month');
        case 'older':
            return translate('sidebar.older', 'Older');
    }
}

function groupConversations(
    items: ConversationSummary[],
    agentChats: AgentConversationAcrossAgents[],
): Section[] {
    if (items.length === 0 && agentChats.length === 0) return [];

    const pinned = items.filter((c) => c.pinned);
    const rest = items.filter((c) => !c.pinned);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Keyed by id, not by the heading. The heading is a sentence the catalogue
    // owns and it changes with the locale; a bucket whose key is its own
    // heading would be looked up in whatever language happened to be loaded.
    const buckets: Record<BucketId, ConversationSummary[]> = {
        today: [],
        yesterday: [],
        this_week: [],
        this_month: [],
        older: [],
    };

    for (const conv of rest) {
        const age = now - new Date(conv.updated_at).getTime();
        const bucket: BucketId =
            age < day
                ? 'today'
                : age < 2 * day
                  ? 'yesterday'
                  : age < 7 * day
                    ? 'this_week'
                    : age < 30 * day
                      ? 'this_month'
                      : 'older';
        buckets[bucket].push(conv);
    }

    const sections: Section[] = [];
    if (pinned.length) sections.push({ title: translate('sidebar.pinned', 'Pinned'), data: pinned });
    for (const [bucket, data] of Object.entries(buckets)) {
        if (data.length) sections.push({ title: bucketTitle(bucket as BucketId), data });
    }
    // Last, and named for what it is. The endpoint behind it returns at most
    // 50 rows and offers no cursor, so this section is honestly "recent" —
    // interleaving it by date would imply a completeness it cannot deliver.
    if (agentChats.length) {
        sections.push({
            title: translate('mobile.chats.recent_with_agents', 'Recent with agents'),
            data: [...agentChats].sort(
                (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            ),
        });
    }
    return sections;
}

