/**
 * One piece of delegated work.
 *
 * The screen a Cowork notification should have opened all along. Until it
 * existed, `/app/cowork/:taskId` was translated to `/tasks` (see
 * `src/features/notifications/model/route.ts`), which lists a different store
 * from `cowork_schedules` — so the app badged a notification "Cowork" and then
 * opened a screen that structurally could not contain the item.
 *
 * Pause, run-now and delete are here because they are the three things a person
 * wants from a phone when something is running without them: stop it, make it
 * happen now, or be rid of it. Delete asks first: the server removes the
 * schedule and its run history for good, and the button sits right under
 * "Run now". Editing the prompt is desktop work and says so.
 */

import { Stack, useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Button, ErrorState, LoadingState, Screen, ScreenHeader, Section, Text, useToast } from '@/shared/ui';

import { ScheduleHistory } from '../components/ScheduleHistory';
import { ScheduleSummary } from '../components/ScheduleSummary';
import { useDeleteSchedule, useRunScheduleNow, useToggleSchedule } from '../hooks/mutations';
import { useSchedule, useScheduleRuns } from '../hooks/queries';
import type { CoworkRun, CoworkSchedule } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
        actions: { gap: theme.spacing.sm },
    });

function useScheduleActions(id: string) {
    const t = useTranslation();
    const router = useRouter();
    const confirm = useConfirm();
    const { toast } = useToast();
    const onError = (error: Error) => toast(describeError(error).message, 'error');
    const toggle = useToggleSchedule(id, { onError });
    const fireNow = useRunScheduleNow(id, {
        onSuccess: () => toast(t('mobile.cowork.started', 'Started. The result will arrive as a notification.')),
        onError,
    });
    const remove = useDeleteSchedule(id, { onSuccess: () => router.back(), onError });
    /** The server hard-deletes the schedule and its runs, so a stray tap must not. */
    const askRemove = async (schedule: CoworkSchedule) => {
        const ok = await confirm({
            title: t('cowork.delete.heading', 'Delete this cowork?'),
            message: t('cowork.delete.consequence', '“{title}” stops running and its history is removed. This can’t be undone.', {
                title: schedule.title,
            }),
            confirmLabel: t('cowork.delete.confirm', 'Delete'),
        });
        if (ok) remove.mutate();
    };
    return { toggle, fireNow, remove, askRemove };
}

function CoworkDetailBody({
    schedule,
    runs,
    actions,
}: {
    schedule: CoworkSchedule;
    runs: CoworkRun[] | undefined;
    actions: ReturnType<typeof useScheduleActions>;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toggle, fireNow, remove, askRemove } = actions;
    return (
        <ScrollView contentContainerStyle={styles.content}>
            <ScheduleSummary schedule={schedule} />

            <Section title={t('cowork.edit.what_it_does', 'What it does')}>
                <Text variant="body" tone="secondary" selectable>
                    {schedule.prompt}
                </Text>
            </Section>

            <View style={styles.actions}>
                <Button
                    label={schedule.isActive ? t('cowork.detail.pause', 'Pause') : t('cowork.detail.resume', 'Resume')}
                    variant="secondary"
                    onPress={() => toggle.mutate()}
                    loading={toggle.isPending}
                />
                <Button
                    label={t('cowork.detail.run_now', 'Run now')}
                    variant="secondary"
                    onPress={() => fireNow.mutate()}
                    loading={fireNow.isPending}
                />
                <Button
                    label={t('common.delete', 'Delete')}
                    variant="danger"
                    onPress={() => void askRemove(schedule)}
                    loading={remove.isPending}
                    testID="cowork-delete"
                />
            </View>

            <ScheduleHistory runCount={schedule.runCount} runs={runs} />

            <Text variant="caption" tone="tertiary">
                {t('mobile.cowork.edit_on_web', 'Changing what this asks for is desktop work — open it in the web app.')}
            </Text>
        </ScrollView>
    );
}

export function CoworkDetailScreen({ id }: { id: string }) {
    const t = useTranslation();
    const schedule = useSchedule(id);
    const runs = useScheduleRuns(id);
    const actions = useScheduleActions(id);
    const data = schedule.data;

    let body: React.ReactElement;
    if (schedule.isLoading) {
        body = <LoadingState />;
    } else if (schedule.isError || !data) {
        body = <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />;
    } else {
        body = <CoworkDetailBody schedule={data} runs={runs.data} actions={actions} />;
    }

    return (
        <Screen edges={['top']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title={data?.title ?? t('sidebar.cowork', 'Cowork')} showBack />
            {body}
        </Screen>
    );
}
