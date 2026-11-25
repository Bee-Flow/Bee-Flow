/**
 * Someone else's Cowork work, shared with the caller: what it does, when it
 * runs next, and its last runs. Read only on purpose: no pause, no run now, no
 * delete. Those are the owner's. (An approver's decisions are made where they
 * always were, in Approvals.)
 */

import { Stack } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ErrorState, ListRow, LoadingState, Screen, ScreenHeader, Section, Text } from '@/shared/ui';

import { useSharedItem, useSharedWithMe } from '../hooks/queries';
import { describeMoment } from '../model/schedule';
import { sharedFooter, sharedLine } from '../model/shared';
import type { SharedRun, SharedView } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
    });

function RunLine({ run }: { run: SharedRun }) {
    const t = useTranslation();
    const failed = run.status === 'failed';
    const title = failed
        ? t('run_status.error', 'Failed')
        : run.status === 'needs_review'
          ? t('cowork_review.status.needs_review', 'Needs review')
          : t('tasks.completed', 'Completed');
    return <ListRow title={title} subtitle={run.result ?? undefined} wrapTitle meta={timeAgo(run.startedAt)} />;
}

function SharedBody({ view, ownerName }: { view: SharedView; ownerName: string | undefined }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { item } = view;
    return (
        <ScrollView contentContainerStyle={styles.content}>
            {ownerName ? (
                <Text variant="caption" tone="tertiary">
                    {sharedLine({ ownerName, role: view.role === 'approver' ? 'approver' : 'viewer' }, t)}
                </Text>
            ) : null}
            {item.nextRunAt && item.isActive ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.cowork.next_when', 'Next: {when}', { when: describeMoment(item.nextRunAt) })}
                </Text>
            ) : null}

            <Section title={t('cowork.edit.what_it_does', 'What it does')}>
                <Text variant="body" tone="secondary" selectable>
                    {item.prompt}
                </Text>
            </Section>

            <Section title={t('documents.history', 'History')}>
                {view.runs.length > 0 ? (
                    view.runs.map((r, i) => <RunLine key={r.id || i} run={r} />)
                ) : (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.cowork.nothing_ran', 'Nothing has run yet.')}
                    </Text>
                )}
            </Section>

            <Text variant="caption" tone="tertiary">
                {sharedFooter(view, ownerName, t)}
            </Text>
        </ScrollView>
    );
}

export function SharedDetailScreen({ id }: { id: string }) {
    const t = useTranslation();
    const shared = useSharedItem(id);
    // The owner's name is on the list row, not on the detail; the list is already cached from the hub.
    const list = useSharedWithMe();
    const ownerName = list.data?.find((i) => i.id === id)?.ownerName;
    const data = shared.data;

    let body: React.ReactElement;
    if (shared.isLoading) {
        body = <LoadingState />;
    } else if (shared.isError || !data) {
        body = <ErrorState error={shared.error} onRetry={() => void shared.refetch()} />;
    } else {
        body = <SharedBody view={data} ownerName={ownerName} />;
    }

    return (
        <Screen edges={['top']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title={data?.item.title || t('sidebar.cowork', 'Cowork')} showBack />
            {body}
        </Screen>
    );
}
