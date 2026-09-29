/**
 * Run history for one automation — and, with `?runId=`, one run in full.
 *
 * Both live in this screen rather than in a nested `runs/[runId]` route because
 * they are one activity: you come here to find the run that went wrong and
 * then read it. A search param keeps the back button meaning "back to the
 * list" without a second navigation stack, and makes a run deep-linkable from
 * the tab hub, the detail screen and a notification alike.
 *
 * The run view polls only while the run is unsettled. `getRunSteps` returns the
 * whole JOURNEY, so a routine that paused for an approval and continued in a
 * child run reads as one timeline — which is the only way the timings make
 * sense.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';

import {
    automateKeys,
    cancelRun,
    decideRunStep,
    getAutomation,
    getRun,
    getRunSteps,
    listRuns,
    retryRun,
} from '../../../src/features/automate/api';
import { RunRow } from '../../../src/features/automate/components/RunRow';
import { RunTimeline } from '../../../src/features/automate/components/RunTimeline';
import { StatusBadge } from '../../../src/features/automate/components/StatusPill';
import {
    absoluteTime,
    formatDuration,
    isLiveStatus,
    runElapsedMs,
    statusLabel,
    statusToken,
} from '../../../src/features/automate/format';
import { useRunStream } from '../../../src/features/automate/useRunStream';
import { useTranslation } from '../../../src/i18n';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../../src/ui/Badge';
import { Button } from '../../../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton, LoadingState, describeError } from '../../../src/ui/Feedback';
import { Screen } from '../../../src/ui/Screen';
import { ScreenHeader } from '../../../src/ui/ScreenHeader';
import { Card, Divider } from '../../../src/ui/Surface';
import { Text } from '../../../src/ui/Text';
import { useToast } from '../../../src/ui/Toast';

/** The statuses worth filtering by. `status` is a CSV query param server-side. */
const FILTERS: { label: string; value: string | undefined }[] = [
    { label: 'All', value: undefined },
    { label: 'Failed', value: 'error' },
    { label: 'Finished', value: 'success' },
    { label: 'Running', value: 'running,queued' },
    { label: 'Waiting', value: 'awaiting_approval,awaiting_form' },
];

export default function RunsScreen() {
    const { id, runId } = useLocalSearchParams<{ id: string; runId?: string }>();
    return runId ? <RunDetail automationId={id} runId={runId} /> : <RunList automationId={id} />;
}

// ── The list ────────────────────────────────────────────────────────

function RunList({ automationId }: { automationId: string }) {
    const theme = useTheme();
    const router = useRouter();
    const [status, setStatus] = useState<string | undefined>(undefined);

    const automation = useQuery({
        queryKey: automateKeys.automation(automationId),
        queryFn: ({ signal }) => getAutomation(automationId, signal),
        enabled: Boolean(automationId),
    });

    const query = useQuery({
        queryKey: [...automateKeys.runs(automationId), status ?? 'all'],
        queryFn: ({ signal }) => listRuns(automationId, { limit: 50, status }, signal),
        enabled: Boolean(automationId),
    });

    // Any run-level movement on this automation changes the list.
    useRunStream({
        automationId,
        onEvent: (event) => {
            if (event.type.startsWith('run.')) void query.refetch();
        },
    });

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Run history"
                subtitle={automation.data?.automation.title ?? undefined}
            />

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.sm,
                }}
            >
                {FILTERS.map((filter) => (
                    <Chip
                        key={filter.label}
                        label={filter.label}
                        selected={status === filter.value}
                        onPress={() => setStatus(filter.value)}
                    />
                ))}
            </ScrollView>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : (query.data ?? []).length === 0 ? (
                <EmptyState
                    icon="clock"
                    title={status ? 'Nothing in that state' : 'No runs yet'}
                    message={
                        status
                            ? 'Try another filter to see what this automation has done.'
                            : 'Run it once and its history starts here — every step, every timing, every error.'
                    }
                    actionLabel={status ? 'Show all runs' : undefined}
                    onAction={status ? () => setStatus(undefined) : undefined}
                />
            ) : (
                <FlatList
                    data={query.data ?? []}
                    keyExtractor={(run) => run.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ItemSeparatorComponent={() => <Divider inset={theme.spacing.lg} />}
                    renderItem={({ item }) => (
                        <RunRow
                            run={item}
                            onPress={() =>
                                router.push(`/automations/${automationId}/runs?runId=${item.id}`)
                            }
                        />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}
        </Screen>
    );
}

// ── One run ─────────────────────────────────────────────────────────

function RunDetail({ automationId, runId }: { automationId: string; runId: string }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const run = useQuery({
        queryKey: automateKeys.run(runId),
        queryFn: ({ signal }) => getRun(runId, signal),
        // Poll only while it is still moving; a finished run never changes.
        refetchInterval: (query) => (isLiveStatus(query.state.data?.status) ? 4000 : false),
    });

    const steps = useQuery({
        queryKey: automateKeys.runSteps(runId),
        queryFn: ({ signal }) => getRunSteps(runId, signal),
        refetchInterval: () => (isLiveStatus(run.data?.status) ? 4000 : false),
    });

    useRunStream({
        automationId,
        enabled: isLiveStatus(run.data?.status),
        onEvent: () => {
            void run.refetch();
            void steps.refetch();
        },
    });

    const invalidateAll = () => {
        void queryClient.invalidateQueries({ queryKey: automateKeys.run(runId) });
        void queryClient.invalidateQueries({ queryKey: automateKeys.runSteps(runId) });
        void queryClient.invalidateQueries({ queryKey: automateKeys.runs(automationId) });
        void queryClient.invalidateQueries({ queryKey: automateKeys.activeRuns });
    };

    const retry = useMutation({
        mutationFn: () => retryRun(automationId, runId),
        onSuccess: (result) => {
            invalidateAll();
            if (result?.run?.id) {
                // The retry is a NEW run linked to this one; showing the old
                // row afterwards would be showing the wrong thing.
                router.replace(`/automations/${automationId}/runs?runId=${result.run.id}`);
                return;
            }
            toast('Retry started — it is still running');
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const cancel = useMutation({
        mutationFn: () => cancelRun(runId),
        onSuccess: () => {
            invalidateAll();
            toast('Stop requested — it ends after the current step');
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const decide = useMutation({
        mutationFn: (decision: 'approve' | 'reject') => decideRunStep(runId, decision),
        onSuccess: () => {
            invalidateAll();
            toast('Decision sent', 'success');
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const elapsed = useMemo(() => (run.data ? runElapsedMs(run.data) : null), [run.data]);

    if (run.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Run" />
                <LoadingState />
            </Screen>
        );
    }

    if (run.isError || !run.data) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Run" />
                <ErrorState
                    error={run.error ?? new Error('This run could not be loaded.')}
                    onRetry={() => void run.refetch()}
                />
            </Screen>
        );
    }

    const current = run.data;
    const token = statusToken(current.status);
    const failed = token.tone === 'error';
    const live = isLiveStatus(current.status);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={statusLabel(t, token)}
                subtitle={current.startedAt ? absoluteTime(current.startedAt) : undefined}
                onBack={() => router.replace(`/automations/${automationId}/runs`)}
            />

            <ScrollView
                contentContainerStyle={{
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.lg,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={run.isRefetching}
                        onRefresh={() => {
                            void run.refetch();
                            void steps.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.lg }}>
                    {/* The error, at the top, in full, selectable. This is the
                        single reason most people open this screen. */}
                    {failed && current.error ? (
                        <Card>
                            <View style={{ gap: theme.spacing.sm }}>
                                <View
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: theme.spacing.sm,
                                    }}
                                >
                                    <Feather
                                        name="alert-circle"
                                        size={18}
                                        color={theme.colors.error}
                                    />
                                    <Text variant="subheading" tone="error" style={{ flex: 1 }}>
                                        What went wrong
                                    </Text>
                                </View>
                                <Text variant="body" selectable>
                                    {current.error}
                                </Text>
                                {current.errorClass ? (
                                    <Badge label={current.errorClass} tone="error" />
                                ) : null}
                            </View>
                        </Card>
                    ) : null}

                    {current.summary && !failed ? (
                        <Card>
                            <Text variant="body">{current.summary}</Text>
                        </Card>
                    ) : null}

                    {current.handledErrorCount > 0 ? (
                        <Banner tone="warning" icon="shield">
                            {`${current.handledErrorCount} step failure${current.handledErrorCount === 1 ? '' : 's'} were caught by an error branch — the run still finished.`}
                        </Banner>
                    ) : null}

                    {current.journeyRunId && current.journeyRunId !== current.id ? (
                        <Banner tone="info">
                            This run paused and continued in a later leg. The outcome and the
                            timeline below are the whole journey.
                        </Banner>
                    ) : null}

                    <Card>
                        <View style={{ gap: theme.spacing.sm }}>
                            <Fact label="Status" value={<StatusBadge status={current.status} />} />
                            <Fact label="Took" text={formatDuration(elapsed)} />
                            <Fact label="Started" text={absoluteTime(current.startedAt)} />
                            {current.finishedAt ? (
                                <Fact label="Finished" text={absoluteTime(current.finishedAt)} />
                            ) : null}
                            <Fact label="Trigger" text={current.triggerKind ?? 'unknown'} />
                            <Fact label="Flow version" text={String(current.version)} />
                            {current.mode === 'dry_run' ? (
                                <Fact label="Mode" value={<Badge label="Test run" />} />
                            ) : null}
                        </View>
                    </Card>

                    {current.status === 'awaiting_approval' ? (
                        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            <Button
                                label="Approve"
                                onPress={() => decide.mutate('approve')}
                                loading={decide.isPending}
                                style={{ flex: 1 }}
                            />
                            <Button
                                label="Reject"
                                variant="destructive"
                                onPress={() => decide.mutate('reject')}
                                disabled={decide.isPending}
                                style={{ flex: 1 }}
                            />
                        </View>
                    ) : live ? (
                        <Button
                            label="Stop this run"
                            variant="destructive"
                            fullWidth
                            loading={cancel.isPending}
                            onPress={() => cancel.mutate()}
                        />
                    ) : (
                        <Button
                            label="Run it again"
                            variant="secondary"
                            fullWidth
                            loading={retry.isPending}
                            onPress={() => retry.mutate()}
                            accessibilityHint="Replays this run with the same trigger data"
                        />
                    )}
                </View>

                <View style={{ gap: theme.spacing.sm }}>
                    <Text
                        variant="label"
                        tone="tertiary"
                        style={{ paddingHorizontal: theme.spacing.lg }}
                    >
                        STEP BY STEP
                    </Text>
                    {steps.isLoading ? (
                        <ListSkeleton rows={4} />
                    ) : steps.isError ? (
                        <View style={{ paddingHorizontal: theme.spacing.lg }}>
                            <Banner
                                tone="error"
                                action={
                                    <Button
                                        label="Retry"
                                        variant="ghost"
                                        onPress={() => void steps.refetch()}
                                    />
                                }
                            >
                                {describeError(steps.error).message}
                            </Banner>
                        </View>
                    ) : (
                        <Card padded={false}>
                            <RunTimeline
                                steps={steps.data?.steps ?? []}
                                definition={steps.data?.definition ?? null}
                            />
                        </Card>
                    )}
                </View>
            </ScrollView>
        </Screen>
    );
}

function Fact({
    label,
    text,
    value,
}: {
    label: string;
    text?: string;
    value?: React.ReactNode;
}) {
    const theme = useTheme();
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.spacing.md,
                minHeight: 28,
            }}
        >
            <Text variant="caption" tone="tertiary">
                {label}
            </Text>
            {value ?? (
                <Text variant="caption" weight="medium" numberOfLines={1}>
                    {text}
                </Text>
            )}
        </View>
    );
}
