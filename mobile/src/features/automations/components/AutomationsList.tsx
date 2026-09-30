/**
 * The list body: skeleton, error, an empty state that says how to start, or
 * the routines — each opening on a tap and offering its menu on a hold. The
 * rows' renderItem is declared at module level (ARCHITECTURE, Performance)
 * and reads the running set and the menu handler from RowContext.
 */

import { useRouter } from 'expo-router';
import React, { createContext, useContext, useMemo } from 'react';
import { FlatList, RefreshControl, type ListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { AutomationListRow } from './AutomationListRow';
import type { useAutomations } from '../hooks/queries';
import type { Automation } from '../model/types';

const makeStyles = (theme: Theme) => ({
    list: { paddingBottom: theme.spacing.xxl } satisfies ViewStyle,
});

const RowContext = createContext<{ runningIds: ReadonlySet<string>; onMenu: (automation: Automation) => void }>({
    runningIds: new Set(),
    onMenu: () => undefined,
});

function Row({ automation }: { automation: Automation }) {
    const router = useRouter();
    const { runningIds, onMenu } = useContext(RowContext);
    return (
        <AutomationListRow
            automation={automation}
            running={runningIds.has(automation.id)}
            onPress={() => router.push(`/automations/${automation.id}`)}
            onLongPress={() => onMenu(automation)}
        />
    );
}

const renderItem: ListRenderItem<Automation> = ({ item }) => <Row automation={item} />;
const keyOf = (item: Automation) => item.id;

export function AutomationsList({
    query,
    items,
    runningIds,
    filtered,
    onClearFilters,
    onNew,
    onMenu,
}: {
    query: ReturnType<typeof useAutomations>;
    items: Automation[];
    runningIds: ReadonlySet<string>;
    /** A search or filter is narrowing the list. */
    filtered: boolean;
    onClearFilters: () => void;
    onNew: () => void;
    onMenu: (automation: Automation) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const rowContext = useMemo(() => ({ runningIds, onMenu }), [runningIds, onMenu]);
    const refresh = useUserRefresh(() => query.refetch());
    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if (items.length === 0) {
        return filtered ? (
            <EmptyState
                icon="Zap"
                title={t('mobile.automations.no_match', 'Nothing matches that')}
                message={t('mobile.automations.no_match_hint', 'Try another word, or clear the filter.')}
                actionLabel={t('routines.overview.clearFilters', 'Clear filters')}
                onAction={onClearFilters}
            />
        ) : (
            <EmptyState
                icon="Zap"
                title={t('routines.empty', 'No routines yet')}
                message={t('mobile.automations.empty_hint', 'Build one step by step, or start from a template.')}
                actionLabel={t('routines.new', 'New routine')}
                onAction={onNew}
            />
        );
    }
    return (
        <RowContext.Provider value={rowContext}>
            <FlatList
                data={items}
                keyExtractor={keyOf}
                refreshControl={
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                renderItem={renderItem}
                contentContainerStyle={styles.list}
            />
        </RowContext.Provider>
    );
}
