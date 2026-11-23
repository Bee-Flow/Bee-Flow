// "Needs you" over GET /api/cowork/needs-you (server/usecases/coworkNeedsYou.mts): everything in Cowork that waits for
// its owner, most urgent first. Titles, statuses and a review's own reason; never what a run read.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

type CoworkNeedKind = 'decision' | 'review' | 'sign_in' | 'plan';
type CoworkPlanNeed = 'first' | 'changed' | 'blocked' | 'gone';

export interface CoworkNeed {
    kind: CoworkNeedKind;
    itemId: string;
    title: string;
    runId: string | null;
    since: string | null;
    reason: string | null;
    plan: CoworkPlanNeed | null;
}

async function getNeedsYou(): Promise<CoworkNeed[]> {
    const body = await apiJson<'GET /api/cowork/needs-you', { needs?: CoworkNeed[] }>('GET /api/cowork/needs-you');
    return Array.isArray(body.needs) ? body.needs : [];
}

/** The list, read again every minute while the page is open, and after any Cowork change (key under 'cowork'). */
export function useCoworkNeedsYou(reloadKey = 0) {
    return useQuery<CoworkNeed[], Error>({
        queryKey: ['cowork', 'needs-you', reloadKey],
        queryFn: getNeedsYou,
        staleTime: 15_000,
        refetchInterval: 60_000,
        retry: false,
    });
}
