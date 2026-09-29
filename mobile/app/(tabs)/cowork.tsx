/**
 * Automate — the tab for everything that runs without you.
 *
 * This is a hub, not a list. The web app puts automations, AI tasks,
 * reminders, projects and Studio apps in five separate sidebar destinations;
 * on a phone that is five taps to answer the only question anyone opens this
 * screen to ask, which is "is anything wrong?".
 *
 * So the order is by urgency, not by feature:
 *   1. What went wrong        — failed runs, first, with the error visible.
 *   2. What is happening now  — live runs, cancellable.
 *   3. What is coming up      — tasks and reminders due soon.
 *   4. Where everything lives — the five destinations, as rows.
 *
 * Sections that the caller's licence does not cover fail quietly and
 * separately: automations sit behind requireLicenseFeature('automations') AND
 * a beta flag, projects behind requireCapability('projects'). A 402/403 on one
 * of them must not take the whole tab down, because tasks and reminders are
 * ungated and still work.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
    automateKeys,
    listApprovals,
    cancelRun,
    listActiveRuns,
    listAutomations,
    listRecentRuns,
    listReminders,
    listTasks,
} from '../../src/features/automate/api';
import { ReminderSheet } from '../../src/features/automate/components/ReminderSheet';
import { RunRow } from '../../src/features/automate/components/RunRow';
import { StatusIcon } from '../../src/features/automate/components/StatusPill';
import { TaskSheet } from '../../src/features/automate/components/TaskSheet';
import { absoluteTime, statusLabel, statusToken } from '../../src/features/automate/format';
import type { AutomationRun, RunEvent } from '../../src/features/automate/types';
import { useRunStream } from '../../src/features/automate/useRunStream';
import { coworkKeys, listSchedules } from '../../src/features/cowork/api';
import { ComposeCowork } from '../../src/features/cowork/ComposeCowork';
import { describeSchedule } from '../../src/features/cowork/schedule';
import { useTranslation } from '../../src/i18n';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { ListRow, SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

/**
 * How far back a stopped run still counts as something that needs you.
 *
 * A failure from eighteen days ago is history, not a task. Awaiting-approval
 * runs are exempt: those genuinely are waiting on a person however long they
 * have waited, and hiding one would lose the decision entirely.
 */
const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Failed and awaiting-approval runs, newest first. The top of the screen. */
function selectNeedsYou(runs: AutomationRun[], now: number): AutomationRun[] {
    const seen = new Set<string>();
    return runs
        .filter((run) => {
            const tone = statusToken(run.status).tone;
            const waiting = run.status === 'awaiting_approval';
            if (tone !== 'error' && !waiting) return false;
            // Age out stale failures. Four cards is the whole section, so a
            // fortnight-old failure does not just add noise — it occupies a
            // slot something current cannot have.
            // `startedAt` is nullable. A run with no start time cannot be
            // aged out on evidence, so it stays — dropping it would hide a
            // failure for a reason that has nothing to do with its age.
            const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
            if (!waiting && startedAt !== null && now - startedAt > NEEDS_YOU_WINDOW_MS) {
                return false;
            }
            // One card per automation. A routine that fails on a schedule
            // produces the SAME failure every run, so without this a single
            // broken automation fills the section with identical rows and
            // hides every other thing that needs you — which is exactly what
            // it did.
            if (seen.has(run.automationId)) return false;
            seen.add(run.automationId);
            return true;
        })
        .slice(0, 4);
}

    // `dataUpdatedAt` rather than `Date.now()`: the age cutoff is a pure
    // function of the data and the moment it was fetched, so calling the clock
    // during render would be both impure and slightly wrong — it would age a
    // run out on a re-render that fetched nothing.

export default function AutomateScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [taskSheet, setTaskSheet] = useState(false);
    const [reminderSheet, setReminderSheet] = useState(false);

    // The reason this tab was renamed. These endpoints have shipped the whole
    // time; nothing in mobile/ had ever called one.
    // A pointer, not a second list: the approvals inbox is its own screen and
    // duplicating it here would be the two-doors-two-screens fault again.
    const pendingApprovals = useQuery({
        queryKey: automateKeys.approvals('pending'),
        queryFn: ({ signal }) => listApprovals('pending', signal),
        staleTime: 60_000,
        retry: 1,
    });

    const schedules = useQuery({
        queryKey: coworkKeys.schedules,
        queryFn: ({ signal }) => listSchedules(signal),
        staleTime: 60_000,
        // A licence or a plan can withhold this; the rest of the tab still works.
        retry: 1,
    });

    const automations = useQuery({
        queryKey: automateKeys.automations,
        queryFn: ({ signal }) => listAutomations(signal),
    });

    const active = useQuery({
        queryKey: automateKeys.activeRuns,
        queryFn: ({ signal }) => listActiveRuns(signal),
        // The SSE feed below is the fast path; this interval is the safety net
        // for the minutes the socket spent asleep in someone's pocket.
        refetchInterval: (query) => (query.state.data?.length ? 10_000 : 60_000),
    });

    const recent = useQuery({
        queryKey: automateKeys.recentRuns,
        queryFn: ({ signal }) => listRecentRuns(25, signal),
    });

    const tasks = useQuery({
        queryKey: automateKeys.tasks,
        queryFn: ({ signal }) => listTasks(signal),
    });

    const reminders = useQuery({
        queryKey: automateKeys.reminders,
        queryFn: ({ signal }) => listReminders(false, signal),
    });

    // The stream says "something moved"; it never carries enough to render a
    // row, so the queries are what actually refresh. Step events are ignored
    // on purpose — a busy loop would invalidate twice a second for a list that
    // only shows run-level state.
    useRunStream({
        onEvent: useCallback(
            (event: RunEvent) => {
                if (!event.type.startsWith('run.')) return;
                void queryClient.invalidateQueries({ queryKey: automateKeys.activeRuns });
                void queryClient.invalidateQueries({ queryKey: automateKeys.recentRuns });
            },
            [queryClient],
        ),
    });

    const titleFor = useMemo(() => {
        const byId = new Map((automations.data ?? []).map((a) => [a.id, a.title]));
        return (id: string) => byId.get(id) ?? 'Automation';
    }, [automations.data]);

    const needsYou = useMemo(
        // No `|| Date.now()` fallback: before the first fetch
        // `dataUpdatedAt` is 0, but `recent.data` is undefined too, so the
        // list is empty and the cutoff never applies to anything.
        () => selectNeedsYou(recent.data ?? [], recent.dataUpdatedAt),
        [recent.data, recent.dataUpdatedAt],
    );

    const upcoming = useMemo(() => buildUpcoming(tasks.data?.tasks ?? [], reminders.data ?? []), [
        tasks.data,
        reminders.data,
    ]);

    const refreshing =
        automations.isRefetching || recent.isRefetching || tasks.isRefetching || reminders.isRefetching;

    const refreshAll = () => {
        void automations.refetch();
        void active.refetch();
        void recent.refetch();
        void tasks.refetch();
        void reminders.refetch();
    };

    const firstLoad = automations.isLoading && recent.isLoading && tasks.isLoading;

    return (
        <Screen edges={['top']} avoidKeyboard>
            <ScreenHeader size="large" title="Cowork" />

            {firstLoad ? (
                <ListSkeleton />
            ) : (
                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.xxxl,
                        gap: theme.spacing.xl,
                    }}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={refreshAll}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                >
                    {/* Licensing answers are normal, and belong next to the thing
                        they gate rather than as a screen-wide failure. */}
                    {automations.isError ? (
                        <Banner
                            tone={
                                describeError(automations.error).retryable ? 'error' : 'info'
                            }
                            action={
                                describeError(automations.error).retryable ? (
                                    <Button
                                        label="Retry"
                                        variant="ghost"
                                        onPress={() => void automations.refetch()}
                                    />
                                ) : undefined
                            }
                        >
                            {describeError(automations.error).message}
                        </Banner>
                    ) : null}

                    {pendingApprovals.data && pendingApprovals.data.length > 0 ? (
                        <Banner
                            tone="warning"
                            icon="clock"
                            action={
                                <Button
                                    label="Open"
                                    variant="ghost"
                                    onPress={() => router.push('/approvals')}
                                />
                            }
                        >
                            {pendingApprovals.data.length === 1
                                ? '1 decision is waiting on you.'
                                : `${pendingApprovals.data.length} decisions are waiting on you.`}
                        </Banner>
                    ) : null}

                    {schedules.data && schedules.data.length > 0 ? (
                        <Section
                            title="Scheduled"
                            subtitle="Work you handed over. It runs whether the app is open or not."
                        >
                            {schedules.data.map((s) => (
                                <ListRow
                                    key={s.id}
                                    title={s.title}
                                    subtitle={
                                        s.isActive
                                            ? describeSchedule(
                                                  {
                                                      presetId: '',
                                                      runAt: s.nextRunAt,
                                                      repeatInterval: s.repeatInterval,
                                                  },
                                              )
                                            : statusLabel(t, statusToken('paused'))
                                    }
                                    meta={s.lastRunAt ? relativeTime(s.lastRunAt) : undefined}
                                    leading={
                                        <Feather
                                            name={s.isActive ? 'clock' : 'pause'}
                                            size={16}
                                            color={
                                                s.isActive
                                                    ? theme.colors.accentText
                                                    : theme.colors.textMuted
                                            }
                                        />
                                    }
                                    onPress={() => router.push(`/cowork/${s.id}`)}
                                />
                            ))}
                        </Section>
                    ) : null}

                    {needsYou.length > 0 ? (
                        <Section
                            title="Needs you"
                            subtitle="Runs that stopped, or are waiting on a decision"
                        >
                            <Card padded={false}>
                                {needsYou.map((run, index) => (
                                    <View key={run.id}>
                                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                        <RunRow
                                            run={run}
                                            automationTitle={titleFor(run.automationId)}
                                            onPress={() =>
                                                router.push(
                                                    `/automations/${run.automationId}/runs?runId=${run.id}`,
                                                )
                                            }
                                        />
                                    </View>
                                ))}
                            </Card>
                        </Section>
                    ) : null}

                    {(active.data ?? []).length > 0 ? (
                        <Section title="Running now">
                            <Card padded={false}>
                                {(active.data ?? []).map((run, index) => (
                                    <View key={run.runId}>
                                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                        <ListRow
                                            title={titleFor(run.automationId)}
                                            subtitle={`${statusLabel(t, statusToken(run.status))} · started ${relativeTime(run.startedAt, { suffix: true })}`}
                                            leading={<StatusIcon status={run.status} />}
                                            trailing={
                                                <IconButton
                                                    icon={
                                                        <Feather
                                                            name="square"
                                                            size={16}
                                                            color={theme.colors.error}
                                                        />
                                                    }
                                                    accessibilityLabel={`Stop ${titleFor(run.automationId)}`}
                                                    tone="destructive"
                                                    onPress={() => {
                                                        void cancelRun(run.runId)
                                                            .then(() => {
                                                                toast('Stop requested');
                                                                void active.refetch();
                                                            })
                                                            .catch((err: unknown) =>
                                                                toast(
                                                                    describeError(err).message,
                                                                    'error',
                                                                ),
                                                            );
                                                    }}
                                                />
                                            }
                                            onPress={() =>
                                                router.push(
                                                    `/automations/${run.automationId}/runs?runId=${run.runId}`,
                                                )
                                            }
                                        />
                                    </View>
                                ))}
                            </Card>
                        </Section>
                    ) : null}

                    <Section
                        title="Coming up"
                        action={
                            <Button
                                label="See all"
                                variant="ghost"
                                onPress={() => router.push('/tasks')}
                            />
                        }
                    >
                        <Card padded={false}>
                            {upcoming.length === 0 ? (
                                <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
                                    <Text variant="body" tone="tertiary">
                                        Nothing scheduled. A task runs a prompt for you; a reminder
                                        just nudges you.
                                    </Text>
                                    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                        <Button
                                            label="New task"
                                            variant="secondary"
                                            onPress={() => setTaskSheet(true)}
                                        />
                                        <Button
                                            label="New reminder"
                                            variant="secondary"
                                            onPress={() => setReminderSheet(true)}
                                        />
                                    </View>
                                </View>
                            ) : (
                                upcoming.map((item, index) => (
                                    <View key={`${item.kind}:${item.id}`}>
                                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                        <ListRow
                                            title={item.title}
                                            subtitle={absoluteTime(item.at)}
                                            leading={
                                                <Feather
                                                    name={item.kind === 'task' ? 'cpu' : 'bell'}
                                                    size={16}
                                                    color={theme.colors.textMuted}
                                                />
                                            }
                                            trailing={
                                                item.overdue ? (
                                                    <Badge label="Due" tone="warning" />
                                                ) : undefined
                                            }
                                            onPress={() => router.push('/tasks')}
                                        />
                                    </View>
                                ))
                            )}
                        </Card>
                    </Section>

                    <Section title="Everything else">
                        <Card padded={false}>
                            <SettingRow
                                label="Automations"
                                value={
                                    automations.data ? String(automations.data.length) : undefined
                                }
                                icon={<Feather name="zap" size={18} color={theme.colors.textMuted} />}
                                onPress={() => router.push('/automations')}
                            />
                            <Divider inset={theme.spacing.lg} />
                            <SettingRow
                                label="Tasks and reminders"
                                value={
                                    tasks.data
                                        ? String(tasks.data.tasks.length + (reminders.data?.length ?? 0))
                                        : undefined
                                }
                                icon={
                                    <Feather name="check-square" size={18} color={theme.colors.textMuted} />
                                }
                                onPress={() => router.push('/tasks')}
                            />
                            <Divider inset={theme.spacing.lg} />
                            <SettingRow
                                label="Projects"
                                icon={
                                    <Feather name="folder" size={18} color={theme.colors.textMuted} />
                                }
                                onPress={() => router.push('/projects')}
                            />
                            <Divider inset={theme.spacing.lg} />
                            <SettingRow
                                label="Apps"
                                icon={
                                    <Feather name="layout" size={18} color={theme.colors.textMuted} />
                                }
                                onPress={() => router.push('/apps')}
                            />
                        </Card>
                    </Section>

                    {(recent.data ?? []).length > 0 ? (
                        <Section title="Recent activity">
                            <Card padded={false}>
                                {(recent.data ?? []).slice(0, 6).map((run, index) => (
                                    <View key={run.id}>
                                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                        <RunRow
                                            run={run}
                                            automationTitle={titleFor(run.automationId)}
                                            onPress={() =>
                                                router.push(
                                                    `/automations/${run.automationId}/runs?runId=${run.id}`,
                                                )
                                            }
                                        />
                                    </View>
                                ))}
                            </Card>
                        </Section>
                    ) : null}
                </ScrollView>
            )}

            {/*
              * Delegating IS this tab's verb, so the composer is pinned where
              * the chat tab pins its own: describe the work, the AI works out
              * the schedule, a sheet asks before anything is created.
              */}
            <ComposeCowork />

            <TaskSheet visible={taskSheet} onClose={() => setTaskSheet(false)} />
            <ReminderSheet visible={reminderSheet} onClose={() => setReminderSheet(false)} />
        </Screen>
    );
}

interface Upcoming {
    kind: 'task' | 'reminder';
    id: string;
    title: string;
    at: string;
    overdue: boolean;
}

/**
 * The next few things due, tasks and reminders merged.
 *
 * Merged rather than sectioned because the distinction is Bee Flow's, not the
 * user's: both are "a thing that happens at a time", and a phone's job at a
 * glance is to say which one is next.
 */
function buildUpcoming(
    tasks: { id: string; title: string; nextRunAt: string | null; isActive: boolean }[],
    reminders: { id: string; title: string; remindAt: string | null }[],
): Upcoming[] {
    const now = Date.now();
    const items: Upcoming[] = [];

    for (const task of tasks) {
        if (!task.isActive || !task.nextRunAt) continue;
        items.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            at: task.nextRunAt,
            overdue: new Date(task.nextRunAt).getTime() <= now,
        });
    }
    for (const reminder of reminders) {
        if (!reminder.remindAt) continue;
        items.push({
            kind: 'reminder',
            id: reminder.id,
            title: reminder.title,
            at: reminder.remindAt,
            overdue: new Date(reminder.remindAt).getTime() <= now,
        });
    }

    return items
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .slice(0, 5);
}
