/**
 * Every automation the signed-in user owns.
 *
 * The list is scoped per user by the server (`getAutomationsForUser` filters on
 * `user_id`), so there is no "mine / everyone" switch to build — a colleague's
 * routine is simply not here.
 *
 * Rows lead with the trigger, not the status, because the trigger is what
 * distinguishes two routines with similar names: "every weekday at 08:00" and
 * "when a form is submitted" are different things to reach for. The status
 * rides on the right, where the eye goes second.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';

import {
    automateKeys,
    listActiveRuns,
    listAutomations,
} from '../../src/features/automate/api';
import { StatusIcon } from '../../src/features/automate/components/StatusPill';
import { absoluteTime, describeTrigger, triggerIcon } from '../../src/features/automate/format';
import type { Automation } from '../../src/features/automate/types';
import { useRunStream } from '../../src/features/automate/useRunStream';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Chip } from '../../src/ui/Badge';
import { EmptyState, ErrorState, ListSkeleton, Spinner } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';

type Filter = 'all' | 'active' | 'paused' | 'failing';

const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'On' },
    { value: 'paused', label: 'Paused' },
    { value: 'failing', label: 'Last run failed' },
];

export default function AutomationsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const query = useQuery({
        queryKey: automateKeys.automations,
        queryFn: ({ signal }) => listAutomations(signal),
    });

    const active = useQuery({
        queryKey: automateKeys.activeRuns,
        queryFn: ({ signal }) => listActiveRuns(signal),
        refetchInterval: (q) => (q.state.data?.length ? 10_000 : 60_000),
    });

    // Only used to move the "running" dot; the row content itself comes from
    // the queries, so a missed frame costs nothing.
    const stream = useRunStream({
        onEvent: () => {
            void active.refetch();
        },
    });

    const runningIds = useMemo(() => {
        const ids = new Set((active.data ?? []).map((run) => run.automationId));
        for (const [runId, status] of Object.entries(stream.statuses)) {
            const match = (active.data ?? []).find((run) => run.runId === runId);
            if (match && status === 'running') ids.add(match.automationId);
        }
        return ids;
    }, [active.data, stream.statuses]);

    const items = useMemo(
        () => filterAutomations(query.data ?? [], search, filter),
        [query.data, search, filter],
    );

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Automations"
                subtitle={query.data ? `${query.data.length} in total` : undefined}
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search automations"
                />
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{
                        gap: theme.spacing.sm,
                        paddingVertical: theme.spacing.xs,
                        paddingRight: theme.spacing.lg,
                    }}
                >
                    {FILTERS.map((option) => (
                        <Chip
                            key={option.value}
                            label={option.label}
                            selected={filter === option.value}
                            onPress={() => setFilter(option.value)}
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
                    icon="zap"
                    title={
                        query.data?.length
                            ? 'Nothing matches that'
                            : 'No automations yet'
                    }
                    message={
                        query.data?.length
                            ? 'Try another word, or clear the filter.'
                            : 'Automations are built on the desktop, where the flow editor lives. Once one exists, you can run it and watch it from here.'
                    }
                    actionLabel={query.data?.length ? 'Clear filters' : undefined}
                    onAction={
                        query.data?.length
                            ? () => {
                                  setSearch('');
                                  setFilter('all');
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
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={({ item }) => (
                        <AutomationListRow
                            automation={item}
                            running={runningIds.has(item.id)}
                            onPress={() => router.push(`/automations/${item.id}`)}
                        />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

function AutomationListRow({
    automation,
    running,
    onPress,
}: {
    automation: Automation;
    running: boolean;
    onPress: () => void;
}) {
    const theme = useTheme();
    const trigger = automation.definition?.trigger ?? null;

    const subtitle = automation.isActive
        ? automation.nextRunAt
            ? `Next ${absoluteTime(automation.nextRunAt).toLowerCase()}`
            : describeTrigger(trigger)
        : automation.isDraft
          ? 'Draft — not finished yet'
          : 'Paused';

    return (
        <ListRow
            title={automation.title || 'Untitled automation'}
            subtitle={subtitle}
            meta={automation.lastRunAt ? relativeTime(automation.lastRunAt) : undefined}
            wrapTitle
            leading={
                running ? (
                    <Spinner />
                ) : (
                    <Feather
                        name={triggerIcon(trigger?.kind ?? automation.triggerType)}
                        size={18}
                        color={
                            automation.isActive ? theme.colors.accentPrimary : theme.colors.textMuted
                        }
                    />
                )
            }
            trailing={
                automation.lastStatus ? (
                    <StatusIcon status={automation.lastStatus} size={16} />
                ) : undefined
            }
            onPress={onPress}
        />
    );
}

function filterAutomations(items: Automation[], search: string, filter: Filter): Automation[] {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
        if (needle) {
            const haystack = `${item.title ?? ''} ${item.description ?? ''}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        switch (filter) {
            case 'active':
                return item.isActive;
            case 'paused':
                return !item.isActive;
            case 'failing':
                // 'failed' is the runner's own word on the automation row; the
                // run table says 'error'. Both mean the same thing here.
                return item.lastStatus === 'error' || item.lastStatus === 'failed';
            default:
                return true;
        }
    });
}
