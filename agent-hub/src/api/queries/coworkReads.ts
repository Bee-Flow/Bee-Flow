// Cowork reads: the run history of one assigned task.

import { useQuery } from '@tanstack/react-query';
import { listCoworkRuns } from '../coworkApi';
import type { CoworkRun } from '../cowork.types';

/**
 * The most recent runs of one item. `reloadKey` is part of the key, so the page
 * bumping it (a run just finished) reads again where the effect used to re-run.
 */
export function useCoworkRunsQuery(coworkId: string | null | undefined, reloadKey: number | undefined) {
    return useQuery<{ runs: CoworkRun[]; total: number }, Error>({
        queryKey: ['cowork', 'runs', coworkId ?? '', reloadKey ?? 0],
        enabled: !!coworkId,
        queryFn: () => listCoworkRuns(coworkId as string),
        staleTime: 0,
        retry: false,
    });
}
