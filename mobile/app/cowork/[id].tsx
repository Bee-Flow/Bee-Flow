/**
 * One piece of delegated work.
 *
 * The screen a Cowork notification should have opened all along. Until now
 * `/app/cowork/:taskId` was translated to `/tasks` (see
 * `src/features/notifications/route.ts`), which lists `/api/ai-tasks` and
 * `/api/reminders` — a different store from `cowork_schedules` — so the app
 * badged a notification "Cowork", offered a "Cowork results" preference for it,
 * and then opened a screen that structurally could not contain the item.
 *
 * Pause, run-now and delete are here because they are the three things a person
 * wants from a phone when something is running without them: stop it, make it
 * happen now, or be rid of it. Editing the prompt is desktop work and says so.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, View } from 'react-native';

import {
    coworkKeys,
    deleteSchedule,
    getSchedule,
    listRuns,
    runNow,
    toggleSchedule,
} from '../../src/features/cowork/api';
import { describeMoment, repeatLabel } from '../../src/features/cowork/schedule';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { ErrorState, LoadingState } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function CoworkDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const schedule = useQuery({
        queryKey: coworkKeys.schedule(id),
        queryFn: ({ signal }) => getSchedule(id, signal),
        enabled: Boolean(id),
    });

    const runs = useQuery({
        queryKey: coworkKeys.runs(id),
        queryFn: ({ signal }) => listRuns(id, signal),
        enabled: Boolean(id),
        staleTime: 30_000,
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: coworkKeys.schedule(id) });
        void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
    };

    const toggle = useMutation({
        mutationFn: () => toggleSchedule(id),
        onSuccess: invalidate,
        onError: () => toast('Could not change that just now'),
    });

    const fireNow = useMutation({
        mutationFn: () => runNow(id),
        onSuccess: () => {
            toast('Started. The result will arrive as a notification.');
            void queryClient.invalidateQueries({ queryKey: coworkKeys.runs(id) });
        },
        onError: () => toast('Could not start it just now'),
    });

    const remove = useMutation({
        mutationFn: () => deleteSchedule(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
            router.back();
        },
        onError: () => toast('Could not delete it just now'),
    });

    const data = schedule.data;

    return (
        <Screen edges={['top']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title={data?.title ?? 'Cowork'} showBack />

            {schedule.isLoading ? (
                <LoadingState />
            ) : schedule.isError || !data ? (
                <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />
            ) : (
                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.xxxl,
                        gap: theme.spacing.xl,
                    }}
                >
                    <View style={{ gap: theme.spacing.sm }}>
                        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            <Badge
                                label={data.isActive ? 'Scheduled' : 'Paused'}
                                tone={data.isActive ? 'success' : 'neutral'}
                            />
                            {data.repeatInterval ? (
                                <Badge label={repeatLabel(data.repeatInterval)} tone="neutral" />
                            ) : null}
                        </View>
                        <Text variant="caption" tone="tertiary">
                            {data.isActive && data.nextRunAt
                                ? `Next: ${describeMoment(data.nextRunAt)}`
                                : data.isActive
                                  ? 'No next run scheduled'
                                  : 'Paused — it will not run until you resume it.'}
                        </Text>
                    </View>

                    <Section title="What it does">
                        <Text variant="body" tone="secondary" selectable>
                            {data.prompt}
                        </Text>
                    </Section>

                    <View style={{ gap: theme.spacing.sm }}>
                        <Button
                            label={data.isActive ? 'Pause' : 'Resume'}
                            variant="secondary"
                            onPress={() => toggle.mutate()}
                            loading={toggle.isPending}
                        />
                        <Button
                            label="Run it now"
                            variant="secondary"
                            onPress={() => fireNow.mutate()}
                            loading={fireNow.isPending}
                        />
                        <Button
                            label="Delete"
                            variant="destructive"
                            onPress={() => remove.mutate()}
                            loading={remove.isPending}
                        />
                    </View>

                    <Section
                        title="History"
                        subtitle={
                            data.runCount === 1 ? 'Ran once' : `Ran ${data.runCount} times`
                        }
                    >
                        {runs.data && runs.data.length > 0 ? (
                            runs.data.map((r, i) => (
                                <ListRow
                                    key={r.id ?? i}
                                    title={r.status === 'failed' ? 'Failed' : 'Completed'}
                                    // The run's own text, not a generic line:
                                    // the notification body already carries the
                                    // whole result, and this is the same thing.
                                    subtitle={r.error ?? r.result ?? undefined}
                                    wrapTitle
                                    meta={relativeTime(r.finishedAt ?? r.startedAt ?? r.createdAt)}
                                    leading={
                                        <Feather
                                            name={r.status === 'failed' ? 'alert-circle' : 'check'}
                                            size={16}
                                            color={
                                                r.status === 'failed'
                                                    ? theme.colors.error
                                                    : theme.colors.success
                                            }
                                        />
                                    }
                                />
                            ))
                        ) : (
                            <Text variant="caption" tone="tertiary">
                                Nothing has run yet.
                            </Text>
                        )}
                    </Section>

                    <Text variant="caption" tone="tertiary">
                        Changing what this asks for is desktop work — open it in the web app.
                    </Text>
                </ScrollView>
            )}
        </Screen>
    );
}
