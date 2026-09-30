/**
 * Every automation the signed-in user owns — and where a new one starts.
 *
 * The list is scoped per user by the server (`getAutomationsForUser` filters on
 * `user_id`), so there is no "mine / everyone" switch to build — a colleague's
 * routine is simply not here.
 *
 * "New routine" opens the flow editor's new-routine screen (from scratch or
 * from a template); holding a row offers editing its flow and deleting it,
 * after asking which app buttons start it.
 */

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Icon, IconButton, Screen, ScreenHeader, SearchField } from '@/shared/ui';

import { AutomationsList } from '../components/AutomationsList';
import { DeleteRoutineSheet } from '../components/DeleteRoutineSheet';
import { NewRoutineMenu } from '../components/NewRoutineMenu';
import { RoutineRowMenu } from '../components/RoutineRowMenu';
import { useSettledRunRefresh } from '../hooks/mutations';
import { useActiveRuns, useAutomations } from '../hooks/queries';
import { useRunStream } from '../hooks/useRunStream';
import { AUTOMATION_FILTERS, filterAutomations, type AutomationFilter } from '../model/filter';
import type { ActiveRun, Automation, RunStatus } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm },
        chips: { gap: theme.spacing.sm, paddingVertical: theme.spacing.xs, paddingRight: theme.spacing.lg },
    });

/** Automations with a run going now — from the poll, moved on by the stream. */
function runningAutomationIds(active: ActiveRun[], statuses: Record<string, RunStatus>): Set<string> {
    const ids = new Set(active.map((run) => run.automationId));
    for (const [runId, status] of Object.entries(statuses)) {
        const match = active.find((run) => run.runId === runId);
        if (match && status === 'running') ids.add(match.automationId);
    }
    return ids;
}

export function AutomationsScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<AutomationFilter>('all');
    const [creating, setCreating] = useState(false);
    const [menu, setMenu] = useState<Automation | null>(null);
    const [deleting, setDeleting] = useState<Automation | null>(null);

    const query = useAutomations();
    const active = useActiveRuns({ busyMs: 10_000, idleMs: 60_000 });

    // Moves the "running" dot at once, and re-reads the list when a run ends
    // (a row's last status and time). The rows come from the queries, so a
    // missed frame costs nothing.
    const refreshList = useSettledRunRefresh();
    const stream = useRunStream({
        onEvent: (event) => {
            void active.refetch();
            refreshList(event);
        },
    });

    const runningIds = useMemo(
        () => runningAutomationIds(active.data ?? [], stream.statuses),
        [active.data, stream.statuses],
    );
    const items = useMemo(
        () => filterAutomations(query.data ?? [], search, filter),
        [query.data, search, filter],
    );

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('studio.tab.automations', 'Automations')}
                subtitle={query.data ? t('mobile.automations.total', '{n} in total', { n: query.data.length }) : undefined}
                actions={
                    <IconButton
                        icon={<Icon name="Plus" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('routines.new', 'New routine')}
                        onPress={() => setCreating(true)}
                    />
                }
            />

            <View style={styles.bar}>
                <SearchField value={search} onChangeText={setSearch} placeholder={t('mobile.automations.search', 'Search automations')} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                    {AUTOMATION_FILTERS.map((option) => (
                        <Chip
                            key={option.value}
                            label={option.label}
                            selected={filter === option.value}
                            onPress={() => setFilter(option.value)}
                        />
                    ))}
                </ScrollView>
            </View>

            <AutomationsList
                query={query}
                items={items}
                runningIds={runningIds}
                filtered={Boolean(query.data?.length)}
                onClearFilters={() => {
                    setSearch('');
                    setFilter('all');
                }}
                onNew={() => setCreating(true)}
                onMenu={setMenu}
            />

            <NewRoutineMenu visible={creating} onClose={() => setCreating(false)} />
            <RoutineRowMenu automation={menu} onClose={() => setMenu(null)} onDelete={setDeleting} />
            <DeleteRoutineSheet automation={deleting} onClose={() => setDeleting(null)} />
        </Screen>
    );
}
