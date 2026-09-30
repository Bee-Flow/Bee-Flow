/**
 * The automation and run queries. Screens call these rather than useQuery, so
 * the keys, the polling rules and the fetchers live in one place.
 */

import { useQuery } from '@tanstack/react-query';

import {
    getAutomation,
    getRun,
    getRunSteps,
    listActiveRuns,
    listAutomations,
    listRecentRuns,
    listRuns,
    previewSchedule,
} from '../api/endpoints';
import { automationKeys } from '../api/keys';
import { isLiveStatus } from '../model/status';

export function useAutomations() {
    return useQuery({
        queryKey: automationKeys.automations,
        queryFn: ({ signal }) => listAutomations(signal),
    });
}

export function useAutomation(id: string) {
    return useQuery({
        queryKey: automationKeys.automation(id),
        queryFn: ({ signal }) => getAutomation(id, signal),
        enabled: Boolean(id),
    });
}

/** The few latest runs a detail screen shows under "Recent runs". */
export function useLatestRuns(automationId: string) {
    return useQuery({
        queryKey: automationKeys.runs(automationId),
        queryFn: ({ signal }) => listRuns(automationId, { limit: 6 }, signal),
        enabled: Boolean(automationId),
    });
}

/** One page of run history, filtered by a status CSV (undefined for all). */
export function useRunHistory(automationId: string, status: string | undefined) {
    return useQuery({
        queryKey: automationKeys.runsFiltered(automationId, status),
        queryFn: ({ signal }) => listRuns(automationId, { limit: 50, status }, signal),
        enabled: Boolean(automationId),
    });
}

export function useRecentRuns() {
    return useQuery({
        queryKey: automationKeys.recentRuns,
        queryFn: ({ signal }) => listRecentRuns(25, signal),
    });
}

/**
 * What is running right now. The SSE feed is the fast path; this interval is
 * the safety net for the minutes the socket spent asleep in someone's pocket,
 * so it polls faster while something is actually running.
 */
export function useActiveRuns({ busyMs, idleMs }: { busyMs: number; idleMs: number }) {
    return useQuery({
        queryKey: automationKeys.activeRuns,
        queryFn: ({ signal }) => listActiveRuns(signal),
        refetchInterval: (query) => (query.state.data?.length ? busyMs : idleMs),
    });
}

/** One run. Polls only while it is still moving; a finished run never changes. */
export function useRun(runId: string) {
    return useQuery({
        queryKey: automationKeys.run(runId),
        queryFn: ({ signal }) => getRun(runId, signal),
        refetchInterval: (query) => (isLiveStatus(query.state.data?.status) ? 4000 : false),
    });
}

/** A run's journey of steps; polls alongside the run while it is `live`. */
export function useRunSteps(runId: string, live: boolean) {
    return useQuery({
        queryKey: automationKeys.runSteps(runId),
        queryFn: ({ signal }) => getRunSteps(runId, signal),
        refetchInterval: () => (live ? 4000 : false),
    });
}

/** The server's own next firing times for a cron under the picker. */
export function useSchedulePreview(cron: string, tz: string) {
    return useQuery({
        queryKey: automationKeys.schedulePreview(cron, tz),
        queryFn: () => previewSchedule(cron, tz, 3),
        // Cheap on the server but rate-limited with the run endpoints, so it is
        // not worth re-asking for a cron we already resolved this session.
        staleTime: 5 * 60_000,
        retry: false,
    });
}
