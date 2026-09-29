/**
 * One automation: run it, watch it, and understand why it failed.
 *
 * The web app builds automations on a node graph. That does not shrink — a
 * canvas on a 6" screen is a canvas you cannot read and must not edit — and
 * putting a WebView in front of the desktop builder would be worse: a
 * pinch-zoom picture of a tool, on a product whose whole promise is that it
 * runs on your own infrastructure and behaves like software rather than a
 * frame around a website.
 *
 * So this screen is the other three quarters of an automation's life, which
 * are all phone-shaped:
 *
 *   run it        — one button, honest about all three answers the server can
 *                   give (finished / still going / nothing to test against).
 *   watch it      — the live SSE feed, plus a poll for the minutes the socket
 *                   spent in a pocket.
 *   understand it — the last failure's error at the TOP of the screen, not
 *                   three taps down in a history list.
 *   adjust it     — name, description, on/off, and the schedule. Everything
 *                   structural says plainly where it can be changed.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { ApiError } from '../../src/api/client';
import {
    automateKeys,
    cancelRun,
    decideRunStep,
    getAutomation,
    listActiveRuns,
    listRuns,
    runAutomation,
    setAutomationActive,
    updateAutomation,
    withSchedule,
} from '../../src/features/automate/api';
import { RunRow } from '../../src/features/automate/components/RunRow';
import { SchedulePicker } from '../../src/features/automate/components/SchedulePicker';
import { StatusIcon } from '../../src/features/automate/components/StatusPill';
import {
    absoluteTime,
    describeTrigger,
    formatDuration,
    runElapsedMs,
    statusLabel,
    statusToken,
} from '../../src/features/automate/format';
import type { Automation, AutomationRun, RunEvent } from '../../src/features/automate/types';
import { useRunStream } from '../../src/features/automate/useRunStream';
import { useTranslation } from '../../src/i18n';
import { plural } from '../../src/lib/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Switch } from '../../src/ui/Controls';
import { Banner, ErrorState, LoadingState, Spinner, describeError } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function AutomationDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [editSheet, setEditSheet] = useState(false);
    const [scheduleSheet, setScheduleSheet] = useState(false);
    /** The "nothing to test against" answer, which is information, not an error. */
    const [runNote, setRunNote] = useState<string | null>(null);

    const detail = useQuery({
        queryKey: automateKeys.automation(id),
        queryFn: ({ signal }) => getAutomation(id, signal),
        enabled: Boolean(id),
    });

    const automation = detail.data?.automation ?? null;

    const runs = useQuery({
        queryKey: automateKeys.runs(id),
        queryFn: ({ signal }) => listRuns(id, { limit: 6 }, signal),
        enabled: Boolean(id),
    });

    const active = useQuery({
        queryKey: automateKeys.activeRuns,
        queryFn: ({ signal }) => listActiveRuns(signal),
        refetchInterval: (query) => (query.state.data?.length ? 5_000 : 30_000),
    });

    const liveRun = useMemo(
        () => (active.data ?? []).find((run) => run.automationId === id) ?? null,
        [active.data, id],
    );

    const refreshRun = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: automateKeys.activeRuns });
        void queryClient.invalidateQueries({ queryKey: automateKeys.runs(id) });
        void queryClient.invalidateQueries({ queryKey: automateKeys.automation(id) });
        void queryClient.invalidateQueries({ queryKey: automateKeys.recentRuns });
    }, [queryClient, id]);

    // Scoped to this automation, so a colleague's busy account does not wake
    // this screen up thirty times a minute.
    const stream = useRunStream({
        automationId: id,
        enabled: Boolean(id),
        onEvent: useCallback(
            (event: RunEvent) => {
                if (event.type.startsWith('run.')) refreshRun();
            },
            [refreshRun],
        ),
    });

    const runMutation = useMutation({
        mutationFn: () => runAutomation(id),
        onSuccess: (result) => {
            setRunNote(null);
            refreshRun();
            if (!result) return;
            if (result.skipped) {
                setRunNote(result.message ?? 'There was nothing to test this trigger against.');
                return;
            }
            if (result.pending) {
                toast('Still running — follow it below');
                return;
            }
            const token = statusToken(result.run?.status);
            toast(statusLabel(t, token), token.tone === 'error' ? 'error' : 'success');
        },
    });

    const activeMutation = useMutation({
        mutationFn: (next: boolean) => setAutomationActive(id, next),
        onSuccess: (updated) => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.automation(id) });
            void queryClient.invalidateQueries({ queryKey: automateKeys.automations });
            toast(updated?.isActive ? 'Automation is on' : 'Automation paused', 'success');
        },
    });

    const scheduleMutation = useMutation({
        mutationFn: (cron: string) => {
            if (!automation) throw new Error('Not loaded');
            const tz = automation.scheduleTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
            // The DEFINITION carries the schedule; the columns are derived from
            // it server-side. See api.ts updateAutomation() for why.
            return updateAutomation(id, { definition: withSchedule(automation.definition, cron, tz) });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.automation(id) });
            void queryClient.invalidateQueries({ queryKey: automateKeys.automations });
            setScheduleSheet(false);
            toast('Schedule saved', 'success');
        },
    });

    if (detail.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Automation" />
                <LoadingState />
            </Screen>
        );
    }

    if (detail.isError || !automation) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Automation" />
                <ErrorState
                    error={detail.error ?? new Error('This automation could not be loaded.')}
                    onRetry={() => void detail.refetch()}
                />
            </Screen>
        );
    }

    const lastRun = runs.data?.[0] ?? null;
    const trigger = automation.definition?.trigger ?? null;
    const stepCount = automation.definition?.steps?.length ?? 0;
    const awaiting = lastRun?.status === 'awaiting_approval' ? lastRun : null;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={automation.title || 'Untitled automation'}
                subtitle={describeTrigger(trigger)}
                actions={
                    <IconButton
                        icon={<Feather name="edit-2" size={18} color={theme.colors.textSecondary} />}
                        accessibilityLabel="Edit name and description"
                        onPress={() => setEditSheet(true)}
                    />
                }
            />

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={detail.isRefetching || runs.isRefetching}
                        onRefresh={() => {
                            void detail.refetch();
                            void runs.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {/* The failure comes FIRST. Everything else on this screen is
                    secondary to "why did last night's run not happen?". */}
                {lastRun && statusToken(lastRun.status).tone === 'error' && lastRun.error ? (
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                <Feather name="alert-circle" size={18} color={theme.colors.error} />
                                <Text variant="subheading" tone="error" style={{ flex: 1 }}>
                                    The last run failed
                                </Text>
                                <Text variant="label" tone="tertiary">
                                    {relativeTime(lastRun.startedAt)}
                                </Text>
                            </View>
                            <Text variant="body" selectable>
                                {lastRun.error}
                            </Text>
                            {lastRun.errorClass ? (
                                <Badge label={lastRun.errorClass} tone="error" />
                            ) : null}
                            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                <Button
                                    label="See what happened"
                                    variant="secondary"
                                    onPress={() =>
                                        router.push(`/automations/${id}/runs?runId=${lastRun.id}`)
                                    }
                                />
                            </View>
                        </View>
                    </Card>
                ) : null}

                {awaiting ? (
                    <ApprovalCard
                        run={awaiting}
                        onDecided={() => {
                            refreshRun();
                            toast('Decision sent', 'success');
                        }}
                    />
                ) : null}

                {/* Live status. Present only while something is actually going,
                    so the screen is quiet when there is nothing to watch. */}
                {liveRun ? (
                    <Card>
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.md,
                            }}
                            accessibilityLiveRegion="polite"
                        >
                            <Spinner />
                            <View style={{ flex: 1, gap: 2 }}>
                                <Text variant="subheading">
                                    {statusLabel(t, statusToken(stream.statuses[liveRun.runId] ?? liveRun.status))}
                                </Text>
                                <Text variant="caption" tone="tertiary">
                                    {stream.last?.stepId
                                        ? `Step ${stream.last.stepId} · started ${relativeTime(liveRun.startedAt, { suffix: true })}`
                                        : `Started ${relativeTime(liveRun.startedAt, { suffix: true })}`}
                                </Text>
                            </View>
                            <Button
                                label="Stop"
                                variant="destructive"
                                onPress={() => {
                                    void cancelRun(liveRun.runId)
                                        .then(() => {
                                            toast('Stop requested — it ends after the current step');
                                            refreshRun();
                                        })
                                        .catch((err: unknown) =>
                                            toast(describeError(err).message, 'error'),
                                        );
                                }}
                            />
                        </View>
                    </Card>
                ) : null}

                {runNote ? <Banner tone="info">{runNote}</Banner> : null}

                {runMutation.isError ? (
                    <Banner tone="error">{describeError(runMutation.error).message}</Banner>
                ) : null}

                <Button
                    label={liveRun ? 'Already running' : 'Run now'}
                    size="lg"
                    fullWidth
                    icon={<Feather name="play" size={18} color={theme.colors.accentPrimaryFg} />}
                    loading={runMutation.isPending}
                    disabled={Boolean(liveRun)}
                    onPress={() => runMutation.mutate()}
                    accessibilityHint="Starts this automation immediately, outside its schedule"
                />

                <Section title="Setup">
                    <Card padded={false}>
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.md,
                                paddingHorizontal: theme.spacing.lg,
                                paddingVertical: theme.spacing.md,
                                minHeight: theme.minTouch,
                            }}
                        >
                            <View style={{ flex: 1, gap: 2 }}>
                                <Text variant="body">Automation is on</Text>
                                <Text variant="caption" tone="tertiary">
                                    {automation.isActive
                                        ? automation.nextRunAt
                                            ? `Next run ${absoluteTime(automation.nextRunAt).toLowerCase()}`
                                            : 'Armed and waiting for its trigger'
                                        : 'Paused — it will not fire on its own'}
                                </Text>
                            </View>
                            {activeMutation.isPending ? (
                                <Spinner />
                            ) : (
                                <Switch
                                    value={automation.isActive}
                                    onValueChange={(next) => activeMutation.mutate(next)}
                                    accessibilityLabel="Automation is on"
                                />
                            )}
                        </View>

                        {/* Activation re-validates the whole flow strictly, so a
                            refusal is a real list of problems, not a hiccup. */}
                        {activeMutation.isError ? (
                            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
                                <Banner tone="error">
                                    <View style={{ gap: 2 }}>
                                        <Text variant="caption">
                                            {describeError(activeMutation.error).message}
                                        </Text>
                                        {activationDetails(activeMutation.error).map((line) => (
                                            <Text key={line} variant="caption" tone="tertiary">
                                                • {line}
                                            </Text>
                                        ))}
                                    </View>
                                </Banner>
                            </View>
                        ) : null}

                        <Divider inset={theme.spacing.lg} />

                        <TriggerRow
                            label="Trigger"
                            value={describeTrigger(trigger)}
                            editable={trigger?.kind === 'schedule'}
                            onEdit={() => setScheduleSheet(true)}
                        />

                        <Divider inset={theme.spacing.lg} />

                        <View
                            style={{
                                paddingHorizontal: theme.spacing.lg,
                                paddingVertical: theme.spacing.md,
                                gap: 2,
                            }}
                        >
                            <Text variant="body">Flow</Text>
                            <Text variant="caption" tone="tertiary">
                                {stepCount > 0
                                    ? `${plural(stepCount, 'step')} · version ${automation.version}`
                                    : `Version ${automation.version}`}
                            </Text>
                            {/* One honest line. Not a broken canvas, not a
                                WebView pretending to be one. */}
                            <Text variant="caption" tone="tertiary">
                                The flow editor is on the desktop. From here you can run it, watch
                                it, change its name and change its schedule.
                            </Text>
                        </View>
                    </Card>
                </Section>

                {automation.description ? (
                    <Section title="About">
                        <Card>
                            <Text variant="body" tone="secondary">
                                {automation.description}
                            </Text>
                        </Card>
                    </Section>
                ) : null}

                <Section
                    title="Recent runs"
                    action={
                        <Button
                            label="See all"
                            variant="ghost"
                            onPress={() => router.push(`/automations/${id}/runs`)}
                        />
                    }
                >
                    <Card padded={false}>
                        {runs.isLoading ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Spinner />
                            </View>
                        ) : runs.isError ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Banner
                                    tone="error"
                                    action={
                                        <Button
                                            label="Retry"
                                            variant="ghost"
                                            onPress={() => void runs.refetch()}
                                        />
                                    }
                                >
                                    {describeError(runs.error).message}
                                </Banner>
                            </View>
                        ) : (runs.data ?? []).length === 0 ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Text variant="body" tone="tertiary">
                                    This automation has never run. Press “Run now” to try it — a
                                    manual run does everything a real one does.
                                </Text>
                            </View>
                        ) : (
                            (runs.data ?? []).map((run, index) => (
                                <View key={run.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <RunRow
                                        run={run}
                                        onPress={() =>
                                            router.push(`/automations/${id}/runs?runId=${run.id}`)
                                        }
                                    />
                                </View>
                            ))
                        )}
                    </Card>
                </Section>

                <Text variant="label" tone="tertiary">
                    {lastRun
                        ? `Last run took ${formatDuration(runElapsedMs(lastRun))}.`
                        : 'No runs recorded yet.'}
                </Text>
            </ScrollView>

            <EditSheet
                visible={editSheet}
                automation={automation}
                onClose={() => setEditSheet(false)}
            />

            <Sheet
                visible={scheduleSheet}
                onClose={() => setScheduleSheet(false)}
                title="Schedule"
                subtitle={automation.title || undefined}
            >
                <SchedulePicker
                    cron={automation.scheduleCron}
                    tz={automation.scheduleTz || Intl.DateTimeFormat().resolvedOptions().timeZone}
                    saving={scheduleMutation.isPending}
                    onSave={(cron) => scheduleMutation.mutate(cron)}
                />
                {scheduleMutation.isError ? (
                    <Banner tone="error">{describeError(scheduleMutation.error).message}</Banner>
                ) : null}
            </Sheet>
        </Screen>
    );
}

function TriggerRow({
    label,
    value,
    editable,
    onEdit,
}: {
    label: string;
    value: string;
    editable: boolean;
    onEdit: () => void;
}) {
    const theme = useTheme();
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                minHeight: theme.minTouch,
            }}
        >
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{label}</Text>
                <Text variant="caption" tone="tertiary">
                    {value}
                </Text>
            </View>
            {editable ? (
                <Button label="Change" variant="secondary" onPress={onEdit} />
            ) : (
                <Text variant="label" tone="tertiary">
                    Desktop only
                </Text>
            )}
        </View>
    );
}

/** Approve or reject the step a paused run is waiting on. */
function ApprovalCard({ run, onDecided }: { run: AutomationRun; onDecided: () => void }) {
    const theme = useTheme();
    const { toast } = useToast();
    const mutation = useMutation({
        mutationFn: (decision: 'approve' | 'reject') => decideRunStep(run.id, decision),
        onSuccess: onDecided,
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    return (
        <Card>
            <View style={{ gap: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                    <StatusIcon status={run.status} />
                    <Text variant="subheading" style={{ flex: 1 }}>
                        Waiting for your decision
                    </Text>
                </View>
                <Text variant="caption" tone="tertiary">
                    {run.summary ??
                        'This run paused at a step that needs a person to say yes before it continues.'}
                </Text>
                {run.awaitingStepExpiresAt ? (
                    <Text variant="caption" tone="warning">
                        Expires {absoluteTime(run.awaitingStepExpiresAt).toLowerCase()}
                    </Text>
                ) : null}
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    <Button
                        label="Approve"
                        onPress={() => mutation.mutate('approve')}
                        loading={mutation.isPending}
                        style={{ flex: 1 }}
                    />
                    <Button
                        label="Reject"
                        variant="destructive"
                        onPress={() => mutation.mutate('reject')}
                        disabled={mutation.isPending}
                        style={{ flex: 1 }}
                    />
                </View>
            </View>
        </Card>
    );
}

function EditSheet({
    visible,
    automation,
    onClose,
}: {
    visible: boolean;
    automation: Automation;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [title, setTitle] = useState(automation.title ?? '');
    const [description, setDescription] = useState(automation.description ?? '');

    const mutation = useMutation({
        mutationFn: () =>
            updateAutomation(automation.id, {
                title: title.trim(),
                description: description.trim(),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.automation(automation.id) });
            void queryClient.invalidateQueries({ queryKey: automateKeys.automations });
            toast('Saved', 'success');
            onClose();
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Rename"
            subtitle="The two things a phone can safely change about a flow."
            footer={
                <Button
                    label="Save"
                    onPress={() => mutation.mutate()}
                    disabled={!title.trim()}
                    loading={mutation.isPending}
                    fullWidth
                    size="lg"
                />
            }
        >
            {mutation.isError ? (
                <Banner tone="error">{describeError(mutation.error).message}</Banner>
            ) : null}
            <TextField label="Name" value={title} onChangeText={setTitle} autoCapitalize="sentences" />
            <TextField
                label="Description"
                value={description}
                onChangeText={setDescription}
                multiline
                maxLines={5}
                autoCapitalize="sentences"
                hint="What this routine is for, in a sentence."
            />
        </Sheet>
    );
}

/**
 * The `details` array a strict activation refusal carries. Without it the user
 * sees "Invalid definition" and has no idea which step is the problem.
 */
function activationDetails(error: unknown): string[] {
    if (!(error instanceof ApiError)) return [];
    const body = error.body as { details?: unknown } | null;
    if (!body || !Array.isArray(body.details)) return [];
    return body.details
        .map((entry) =>
            typeof entry === 'string'
                ? entry
                : typeof (entry as { message?: string })?.message === 'string'
                  ? ((entry as { message: string }).message)
                  : null,
        )
        .filter((line): line is string => Boolean(line))
        .slice(0, 6);
}
