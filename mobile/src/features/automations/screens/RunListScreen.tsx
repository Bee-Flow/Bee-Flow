/** One automation's run history, filterable by how the runs ended. */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Chip, EmptyState, ErrorState, InsetDivider, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { RunRow } from '../components/RunRow';
import { useAutomation, useRunHistory } from '../hooks/queries';
import { useRunStream } from '../hooks/useRunStream';

/** The statuses worth filtering by. `status` is a CSV query param server-side. */
const FILTERS: { i18nKey: string; en: string; value: string | undefined }[] = [
    { i18nKey: 'runs.tab.filter_all', en: 'All', value: undefined },
    { i18nKey: 'runs.tab.filter_failed', en: 'Failed', value: 'error' },
    { i18nKey: 'runs.log.filter_finished', en: 'Finished', value: 'success' },
    { i18nKey: 'runs.tab.filter_running', en: 'Running', value: 'running,queued' },
    { i18nKey: 'approvals.status_pending', en: 'Waiting', value: 'awaiting_approval,awaiting_form' },
];

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        chips: { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        list: { paddingBottom: theme.spacing.xxl },
    });

export function RunListScreen({ automationId }: { automationId: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const t = useTranslation();
    const [status, setStatus] = useState<string | undefined>(undefined);

    const automation = useAutomation(automationId);
    const query = useRunHistory(automationId, status);
    // The person's pull only: every run event on this automation refetches the list.
    const refresh = useUserRefresh(() => query.refetch());

    // Any run-level movement on this automation changes the list.
    useRunStream({
        automationId,
        onEvent: (event) => {
            if (event.type.startsWith('run.')) void query.refetch();
        },
    });

    let body: React.ReactElement;
    if (query.isLoading) {
        body = <ListSkeleton />;
    } else if (query.isError) {
        body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    } else if ((query.data ?? []).length === 0) {
        body = (
            <EmptyState
                icon="Clock"
                title={
                    status
                        ? t('mobile.automations.runs.no_match', 'Nothing in that state')
                        : t('mobile.automations.runs.none', 'No runs yet')
                }
                message={
                    status
                        ? t('mobile.automations.runs.no_match_hint', 'Try another filter to see what this automation has done.')
                        : t('mobile.automations.runs.none_hint', 'Run it once and its history starts here — every step, every timing, every error.')
                }
                actionLabel={status ? t('mobile.automations.runs.show_all', 'Show all runs') : undefined}
                onAction={status ? () => setStatus(undefined) : undefined}
            />
        );
    } else {
        body = (
            <FlatList
                data={query.data ?? []}
                keyExtractor={(run) => run.id}
                refreshControl={
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                ItemSeparatorComponent={InsetDivider}
                renderItem={({ item }) => (
                    <RunRow
                        run={item}
                        onPress={() => router.push(`/automations/${automationId}/runs?runId=${item.id}`)}
                    />
                )}
                contentContainerStyle={styles.list}
            />
        );
    }

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={t('automation_editor.run_history', 'Run history')} subtitle={automation.data?.automation.title ?? undefined} />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {FILTERS.map((filter) => (
                    <Chip
                        key={filter.i18nKey}
                        label={t(filter.i18nKey, filter.en)}
                        selected={status === filter.value}
                        onPress={() => setStatus(filter.value)}
                    />
                ))}
            </ScrollView>

            {body}
        </Screen>
    );
}
