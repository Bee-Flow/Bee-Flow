// "Needs you" over GET /api/cowork/needs-you (server/usecases/coworkNeedsYou.mts): everything in Cowork that waits for
// its owner, most urgent first. Titles, statuses and a review's own reason; never what a run read.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

type CoworkNeedKind = 'decision' | 'review' | 'sign_in' | 'repair' | 'plan';
type CoworkPlanNeed = 'first' | 'changed' | 'blocked' | 'gone';

export interface CoworkNeed {
    kind: CoworkNeedKind;
    itemId: string;
    title: string;
    runId: string | null;
    since: string | null;
    reason: string | null;
    plan: CoworkPlanNeed | null;
    /** A repair Cowork worked out: why, and the step it is about. */
    repair?: { proposalId: string; reasonCode: string; stepTitle: string | null } | null;
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

/** The daily e-mail of this list (GET/PUT /api/cowork/daily-mail): the caller's own setting. */
export interface CoworkDailyMail {
    enabled: boolean;
    timeZone: string;
    /** The instance can send mail at all (a service mailbox is set up). */
    available: boolean;
}

const dailyMailKey = ['cowork', 'daily-mail'] as const;

export function useCoworkDailyMail() {
    const client = useQueryClient();
    const query = useQuery<CoworkDailyMail, Error>({
        queryKey: dailyMailKey,
        queryFn: () => apiJson<'GET /api/cowork/daily-mail', CoworkDailyMail>('GET /api/cowork/daily-mail'),
        retry: false,
    });
    // The owner's morning is the browser's time zone at the moment they switch it on.
    const save = useMutation<CoworkDailyMail, Error, boolean>({
        mutationFn: (enabled) => apiJson<'PUT /api/cowork/daily-mail', CoworkDailyMail>('PUT /api/cowork/daily-mail', {
            body: { enabled, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
        }),
        onSuccess: (saved) => { client.setQueryData(dailyMailKey, saved); },
    });
    return { query, save };
}
