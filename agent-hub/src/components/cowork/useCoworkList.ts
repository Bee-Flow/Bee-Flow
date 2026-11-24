/**
 * The owner's tasks (GET /api/cowork), for the home and the task sheet: one query, so both read the same list.
 *
 * Results arrive asynchronously (the runner reports into notifications), so the list is read again every 10 s while
 * something is mid-run rather than showing a run that never ends until a reload; it stops as soon as it settles.
 */
import { useQuery } from '@tanstack/react-query';
import { listCowork } from '@/api/coworkApi';
import { isInFlight } from './coworkStatus';
import type { CoworkItem } from '@/api/cowork.types';

const COWORK_LIST_KEY = ['cowork', 'list'] as const;

export default function useCoworkList() {
    return useQuery<{ items: CoworkItem[]; maxItems: number }>({
        queryKey: COWORK_LIST_KEY,
        staleTime: 0,
        retry: false,
        refetchInterval: (q) => ((q.state.data as { items: CoworkItem[] } | undefined)?.items.some(isInFlight) ? 10_000 : false),
        refetchIntervalInBackground: true,
        queryFn: listCowork,
    });
}
