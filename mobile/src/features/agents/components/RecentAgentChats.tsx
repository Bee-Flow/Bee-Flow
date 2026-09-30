/**
 * Recent chats across every agent — the only way back to a conversation whose
 * agent you cannot remember. Server-capped at 50 rows with no cursor, so it is
 * labelled "recent" rather than offered as a full history.
 */

import React from 'react';
import { FlatList, RefreshControl } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, Icon, ListRow, ListSkeleton } from '@/shared/ui';

import { AgentAvatar } from './AgentAvatar';
import { useAllAgentConversations } from '../hooks/queries';
import type { AgentConversationAcrossAgents } from '../model/types';

const makeStyles = (theme: Theme) => ({
    content: { paddingBottom: theme.spacing.xxl },
});

export function RecentAgentChats({ onOpen }: { onOpen: (conversation: AgentConversationAcrossAgents) => void }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const query = useAllAgentConversations();
    const refresh = useUserRefresh(() => query.refetch());

    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if ((query.data ?? []).length === 0) {
        return (
            <EmptyState
                icon="MessageCircle"
                title="No agent chats yet"
                message="Open an agent and ask it something — the conversation shows up here afterwards."
            />
        );
    }

    const renderItem = ({ item }: { item: AgentConversationAcrossAgents }) => (
        <ListRow
            // A conversation whose title generation has not run yet has none
            // at all; the row still has to be tappable.
            title={item.title || 'Untitled chat'}
            subtitle={item.agent_name ?? 'Deleted agent'}
            meta={timeAgo(item.updated_at)}
            wrapTitle
            leading={<AgentAvatar name={item.agent_name ?? 'Agent'} avatar={item.agent_avatar} size={36} />}
            trailing={item.pinned ? <Icon name="Bookmark" size={16} color={theme.colors.textMuted} /> : undefined}
            onPress={() => onOpen(item)}
        />
    );

    return (
        <FlatList
            data={query.data ?? []}
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
    );
}
