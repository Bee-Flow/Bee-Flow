/** The Cowork queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import {
    getRunReceipt,
    getSchedule,
    getShared,
    listNeedsYou,
    listScheduleRuns,
    listSchedules,
    listShared,
} from '../api/endpoints';
import { coworkKeys } from '../api/keys';

/** Every schedule. A licence or a plan can withhold this; the hub still works. */
export function useSchedules() {
    return useQuery({
        queryKey: coworkKeys.schedules,
        queryFn: ({ signal }) => listSchedules(signal),
        staleTime: 60_000,
        retry: 1,
    });
}

/** "Waiting for you": read when the hub opens and on every pull; a failure leaves the section out. */
export function useNeedsYou() {
    return useQuery({
        queryKey: coworkKeys.needsYou,
        queryFn: ({ signal }) => listNeedsYou(signal),
        staleTime: 30_000,
        retry: 1,
    });
}

export function useSchedule(id: string) {
    return useQuery({
        queryKey: coworkKeys.schedule(id),
        queryFn: ({ signal }) => getSchedule(id, signal),
        enabled: Boolean(id),
    });
}

export function useScheduleRuns(id: string) {
    return useQuery({
        queryKey: coworkKeys.runs(id),
        queryFn: ({ signal }) => listScheduleRuns(id, signal),
        enabled: Boolean(id),
        staleTime: 30_000,
    });
}

/** "Shared with you": a failure leaves the section out, like the schedules. */
export function useSharedWithMe() {
    return useQuery({
        queryKey: coworkKeys.shared,
        queryFn: ({ signal }) => listShared(signal),
        staleTime: 60_000,
        retry: 1,
    });
}

export function useSharedItem(id: string) {
    return useQuery({
        queryKey: coworkKeys.sharedItem(id),
        queryFn: ({ signal }) => getShared(id, signal),
        enabled: Boolean(id),
    });
}

/** Only for a run that is open: a receipt per row of a list would be a request per row. */
export function useRunReceipt(id: string, runId: string, enabled: boolean) {
    return useQuery({
        queryKey: coworkKeys.receipt(id, runId),
        queryFn: ({ signal }) => getRunReceipt(id, runId, signal),
        enabled: enabled && Boolean(id) && Boolean(runId),
        staleTime: 60_000,
        retry: false,
    });
}
