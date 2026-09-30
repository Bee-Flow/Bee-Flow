/** The Cowork queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { getSchedule, listScheduleRuns, listSchedules } from '../api/endpoints';
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
