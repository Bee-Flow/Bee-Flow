/**
 * Everything the Cowork hub reads, and what it derives.
 *
 * Sections the caller's licence does not cover fail quietly and separately:
 * automations sit behind requireLicenseFeature('automations') AND a beta
 * flag, approvals behind requireModule('approvals'). A 402/403 on one of them
 * must not take the whole tab down, because tasks and reminders are ungated.
 */

import { useCallback, useMemo } from 'react';

import { useApprovals } from '@/features/approvals';
import {
    useActiveRuns,
    useAutomations,
    useRecentRuns,
    useRunListsRefresh,
    useRunStream,
    type RunEvent,
} from '@/features/automations';
import { useNeedsYou, useSchedules, useSharedWithMe } from '@/features/cowork';
import { useReminders, useTasks } from '@/features/tasks';
import { useUserRefresh } from '@/shared/patterns';

import { buildUpcoming, selectNeedsYou } from '../model/hub';

export function useCoworkHub() {
    // A pointer, not a second list: the approvals inbox is its own screen and
    // duplicating it here would be the two-doors-two-screens fault again.
    const pendingApprovals = useApprovals('pending', { staleTime: 60_000, retry: 1 });
    const schedules = useSchedules();
    // "Waiting for you": what of the owner's Cowork work waits for them (a decision, a review, a sign-in, a plan).
    const coworkNeeds = useNeedsYou();
    // Other people's work shared with the caller; the section only shows when there is some.
    const shared = useSharedWithMe();
    const automations = useAutomations();
    const active = useActiveRuns({ busyMs: 10_000, idleMs: 60_000 });
    const recent = useRecentRuns();
    const tasks = useTasks();
    const reminders = useReminders();

    // The stream says "something moved"; it never carries enough to render a
    // row, so the queries are what actually refresh. Step events are ignored.
    const refreshRuns = useRunListsRefresh();
    useRunStream({
        onEvent: useCallback(
            (event: RunEvent) => {
                if (event.type.startsWith('run.')) refreshRuns();
            },
            [refreshRuns],
        ),
    });

    const titleFor = useMemo(() => {
        const byId = new Map((automations.data ?? []).map((a) => [a.id, a.title]));
        return (id: string) => byId.get(id) ?? 'Automation';
    }, [automations.data]);

    // No `|| Date.now()` fallback: before the first fetch `dataUpdatedAt` is
    // 0, but `recent.data` is undefined too, so the cutoff applies to nothing.
    const needsYou = useMemo(
        () => selectNeedsYou(recent.data ?? [], recent.dataUpdatedAt),
        [recent.data, recent.dataUpdatedAt],
    );

    const upcoming = useMemo(
        () => buildUpcoming(tasks.data?.tasks ?? [], reminders.data ?? []),
        [tasks.data, reminders.data],
    );

    // The person's pull only. Every run event invalidates the recent runs, so
    // their `isRefetching` would drop the refresh circle in by itself.
    const { refreshing, onRefresh: refreshAll } = useUserRefresh(() =>
        Promise.all([automations.refetch(), active.refetch(), recent.refetch(), tasks.refetch(), reminders.refetch(), coworkNeeds.refetch(), shared.refetch()]),
    );

    return {
        pendingApprovals,
        schedules,
        coworkNeeds,
        shared,
        automations,
        active,
        recent,
        tasks,
        reminders,
        titleFor,
        needsYou,
        upcoming,
        refreshing,
        refreshAll,
        firstLoad: automations.isLoading && recent.isLoading && tasks.isLoading,
    };
}

export type CoworkHub = ReturnType<typeof useCoworkHub>;
