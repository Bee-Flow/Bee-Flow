/**
 * Every agent the user can open, merged from `/agents/published` and
 * `/agents` (see api/endpoints.ts for why both), searched locally because the
 * list is tens of rows and a round-trip per keystroke is slower than the
 * filter it replaces. Favourites are DB-backed, so the same agents are starred
 * here and on the web.
 */

import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { AgentFilters } from './AgentFilters';
import { AgentRow } from './AgentRow';
import { NewAgentMenu } from './NewAgentButton';
import { useToggleFavorite } from '../hooks/mutations';
import { useAgents, useFavoriteAgents } from '../hooks/queries';
import { ALL, filterAgents } from '../model/format';
import { canCreateAgents } from '../model/permissions';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    content: { paddingBottom: theme.spacing.xxl },
});

/**
 * No agents at all: someone who may create one (manage_agents, as the New
 * button) is offered the same New menu, as the web's AgentOverview does;
 * anyone else is told who makes them.
 */
function NoAgents() {
    const t = useTranslation();
    const [menu, setMenu] = useState(false);
    const canCreate = canCreateAgents(useHasPermission('manage_agents'));
    return (
        <>
            <EmptyState
                icon="Cpu"
                title={t('agent_studio.empty_title', 'No agents yet')}
                message={
                    canCreate
                        ? t('agent_studio.empty_body', 'An agent answers questions in your own words, using the knowledge and tools you give it.')
                        : t('mobile.agents.empty_member', 'An administrator creates the agents in your organisation. Once one is shared with you, it appears here.')
                }
                actionLabel={canCreate ? t('agent_studio.new_agent', 'New agent') : undefined}
                onAction={canCreate ? () => setMenu(true) : undefined}
            />
            {canCreate ? <NewAgentMenu visible={menu} onClose={() => setMenu(false)} /> : null}
        </>
    );
}

export function AgentList({ onOpen }: { onOpen: (id: string) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<string>(ALL);
    const query = useAgents();
    const favorites = useFavoriteAgents();
    const refresh = useUserRefresh(() => Promise.all([query.refetch(), favorites.refetch()]));
    const toggleFavorite = useToggleFavorite();

    const favoriteIds = useMemo(() => new Set(favorites.data ?? []), [favorites.data]);
    const items = useMemo(
        () => filterAgents(query.data ?? [], search, category, favoriteIds),
        [query.data, search, category, favoriteIds],
    );
    const filtersApplied = search.trim().length > 0 || category !== ALL;

    const renderItem = ({ item }: { item: Agent }) => (
        <AgentRow
            agent={item}
            favorite={favoriteIds.has(item.id)}
            onPress={() => onOpen(item.id)}
            onToggleFavorite={() => toggleFavorite.mutate({ id: item.id, next: !favoriteIds.has(item.id) })}
        />
    );

    return (
        <>
            <AgentFilters search={search} onSearch={setSearch} category={category} onCategory={setCategory} />
            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 && !filtersApplied ? (
                <NoAgents />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="Cpu"
                    title={t('agent_studio.search_empty', 'No agent matches that.')}
                    message={t('mobile.agents.no_match_hint', 'Try another word, or clear the filter.')}
                    actionLabel={t('store.clear_filters', 'Clear filters')}
                    onAction={() => {
                        setSearch('');
                        setCategory(ALL);
                    }}
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
        </>
    );
}
