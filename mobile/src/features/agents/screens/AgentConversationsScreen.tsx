/**
 * Every conversation you have had with one agent.
 *
 * Separate from the cross-agent list on /agents because the two answer
 * different questions — "where was I" versus "what have I asked this agent
 * before" — and this is the only complete one: the cross-agent endpoint is
 * capped at 50 rows server-side while this one is not.
 *
 * Pinned rows float to the top (the server orders by `updated_at` only).
 * Pin, rename and delete are on a long-press rather than a swipe: a swipe is
 * easy to trigger by accident, and deleting a conversation is not undoable.
 * The menu is AgentConversationActions.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import {
    EmptyState,
    ErrorState,
    Icon,
    IconButton,
    ListRow,
    ListSkeleton,
    Screen,
    ScreenHeader,
    SearchField,
} from '@/shared/ui';

import { AgentConversationActions } from '../components/AgentConversationActions';
import { useAgent, useAgentConversations } from '../hooks/queries';
import { sortAndFilterConversations } from '../model/format';
import type { AgentConversationSummary } from '../model/types';

const makeStyles = (theme: Theme) => ({
    search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    content: { paddingBottom: theme.spacing.xxl },
});

export function AgentConversationsScreen({ id }: { id: string }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [search, setSearch] = useState('');
    const [target, setTarget] = useState<AgentConversationSummary | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // Only for the header; almost always cached from the profile already.
    const agent = useAgent(id);
    const query = useAgentConversations(id);
    const refresh = useUserRefresh(() => query.refetch());
    const items = useMemo(() => sortAndFilterConversations(query.data ?? [], search), [query.data, search]);
    const startNew = () => router.push(`/agents/${id}?c=new`);

    const openMenu = (conversation: AgentConversationSummary) => {
        setTarget(conversation);
        setMenuOpen(true);
    };

    const renderItem = ({ item }: { item: AgentConversationSummary }) => (
        <ListRow
            title={item.title || 'Untitled chat'}
            subtitle={t('mobile.agents.started_when', 'Started {when}', { when: timeAgo(item.created_at, { suffix: true }) })}
            meta={timeAgo(item.updated_at)}
            wrapTitle
            leading={
                <Icon
                    name={item.pinned ? 'Bookmark' : 'MessageSquare'}
                    size={18}
                    color={item.pinned ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            onPress={() => router.push(`/agents/${id}?c=${item.id}`)}
            onLongPress={() => openMenu(item)}
            testID={`agent-conversation-${item.id}`}
        />
    );

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title="Conversations"
                subtitle={agent.data?.name ?? undefined}
                actions={
                    <IconButton
                        icon={<Icon name="SquarePen" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel="Start a new conversation"
                        onPress={startNew}
                    />
                }
            />
            {(query.data ?? []).length > 0 ? (
                <View style={styles.search}>
                    <SearchField value={search} onChangeText={setSearch} placeholder="Search these conversations" />
                </View>
            ) : null}
            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="MessageSquare"
                    title={search.trim() ? 'Nothing matches that' : 'No conversations yet'}
                    message={
                        search.trim()
                            ? 'Titles are generated after the first exchange, so a very new chat may not be searchable yet.'
                            : 'Ask this agent something and the conversation is kept here.'
                    }
                    actionLabel={search.trim() ? 'Clear search' : 'Start a conversation'}
                    onAction={search.trim() ? () => setSearch('') : startNew}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={refresh.refreshing}
                            onRefresh={refresh.onRefresh}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={renderItem}
                    contentContainerStyle={styles.content}
                />
            )}
            {target ? (
                <AgentConversationActions
                    key={target.id}
                    agentId={id}
                    conversation={target}
                    menuOpen={menuOpen}
                    onCloseMenu={() => setMenuOpen(false)}
                    onClose={() => setTarget(null)}
                />
            ) : null}
        </Screen>
    );
}
