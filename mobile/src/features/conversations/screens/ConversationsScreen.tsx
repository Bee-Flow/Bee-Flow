/**
 * Every conversation, one tap from the Chat tab's "All conversations".
 *
 * Direct chats grouped by recency, pinned first, and agent chats under their
 * own heading (model/grouping.ts says why they are not interleaved). They used
 * to live only under More → Agents, so somebody who talked to an agent
 * yesterday opened Chat, did not find it, and reasonably concluded the app had
 * lost it.
 *
 * It is also where people clean up, so a long-press or a row's ⋯ opens
 * rename, pin and delete, as in the drawer (components/ConversationMenu).
 *
 * There is no search field. There used to be, filtering titles on the client,
 * which competed with the real server-side search one icon away in the header
 * and quietly claimed to have searched conversations it had never loaded.
 */

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { RefreshControl, SectionList } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAllAgentConversations } from '@/features/agents';
import { useConversations } from '@/features/chat';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton, Screen, ScreenHeader, Text } from '@/shared/ui';

import { ConversationListRow } from '../components/ConversationListRow';
import { ConversationMenuHost } from '../components/ConversationMenu';
import { groupConversations, type ConversationRow, type ConversationSection } from '../model/grouping';

const makeStyles = (theme: Theme) => ({
    heading: {
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.lg,
        paddingBottom: theme.spacing.xs,
    },
    content: { paddingBottom: 96 },
});

const keyOf = (item: ConversationRow) => item.id;
const renderRow = ({ item }: { item: ConversationRow }) => <ConversationListRow item={item} />;

export function ConversationsScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const t = useTranslation();
    const query = useConversations();
    const refresh = useUserRefresh(() => query.refetch());
    // A nice-to-have on this screen, not its reason for existing: a failure
    // here must not take the list down — the section simply does not appear.
    const agentChats = useAllAgentConversations({ staleTime: 60_000 });

    const sections = useMemo(
        () => groupConversations(query.data ?? [], agentChats.data ?? []),
        [query.data, agentChats.data],
    );

    const renderHeading = ({ section }: { section: ConversationSection }) => (
        <Text variant="label" tone="tertiary" style={styles.heading}>
            {section.title.toUpperCase()}
        </Text>
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
                    icon="MessageSquare"
                    title={t('sidebar.no_chats_yet', 'No chats yet')}
                    message={t(
                        'mobile.chats.empty_message',
                        'Start a conversation and it will appear here, on every device you sign in to.',
                    )}
                    actionLabel={t('sidebar.new_chat', 'New Chat')}
                    onAction={() => router.push('/chat/new')}
                />
            ) : (
                <ConversationMenuHost>
                    <SectionList
                        sections={sections}
                        keyExtractor={keyOf}
                        stickySectionHeadersEnabled={false}
                        refreshControl={
                            <RefreshControl
                                refreshing={refresh.refreshing}
                                onRefresh={refresh.onRefresh}
                                tintColor={theme.colors.accentPrimary}
                                colors={[theme.colors.accentPrimary]}
                            />
                        }
                        renderSectionHeader={renderHeading}
                        renderItem={renderRow}
                        contentContainerStyle={styles.content}
                    />
                </ConversationMenuHost>
            )}
        </Screen>
    );
}
