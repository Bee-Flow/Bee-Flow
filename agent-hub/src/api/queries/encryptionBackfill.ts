// "Encrypt existing data" for an organisation — the ONLY place that knows the
// /auth/organizations/:id/encryption/backfill wire contract.
//
// The job lives in the server's memory (one instance); this hook polls its
// state every 2 s while it runs and not at all otherwise.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export type BackfillStatus = 'idle' | 'running' | 'done' | 'error';

export interface BackfillSurfaceStats {
    encrypted: number;
    skipped: number;
    noKey: number;
    failed: number;
    /** legacyBlobs only: conversations moved into the message table. */
    migrated?: number;
    /** legacyBlobs only: why rows were skipped. */
    reasons?: Record<string, number>;
    /** legacyBlobs only: set when the run did not start because `messages` failed. */
    blocked?: string;
}

export interface BackfillJob {
    status: BackfillStatus;
    dryRun: boolean | null;
    startedAt: string | null;
    finishedAt: string | null;
    surfaces: Record<string, BackfillSurfaceStats>;
    error: string | null;
}

export const BACKFILL_POLL_MS = 2000;

export const backfillKeys = {
    job: (orgId: string) => ['org-encryption-backfill', orgId] as const,
};

const url = (orgId: string) => `${API_BASE}/auth/organizations/${encodeURIComponent(orgId)}/encryption/backfill`;

async function failure(res: Response, fallback: string): Promise<Error> {
    const body = await res.json().catch(() => ({}));
    return new Error(body.message || (typeof body.error === 'string' ? body.error : '') || fallback);
}

export async function fetchBackfillJob(orgId: string, signal?: AbortSignal): Promise<BackfillJob> {
    const res = await authFetch(url(orgId), { signal });
    if (!res.ok) throw await failure(res, `backfill ${res.status}`);
    return res.json();
}

export function useBackfillJobQuery(orgId: string | undefined, enabled: boolean) {
    return useQuery<BackfillJob, Error>({
        queryKey: backfillKeys.job(orgId || ''),
        queryFn: ({ signal }) => fetchBackfillJob(orgId as string, signal),
        enabled: !!orgId && enabled,
        retry: false,
        refetchInterval: (query) => (query.state.data?.status === 'running' ? BACKFILL_POLL_MS : false),
    });
}

export function useStartBackfill(orgId: string | undefined) {
    const qc = useQueryClient();
    return useMutation<BackfillJob, Error, { dryRun: boolean }>({
        mutationFn: async ({ dryRun }) => {
            const res = await authFetch(url(orgId as string), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun }),
            });
            if (!res.ok) throw await failure(res, `backfill ${res.status}`);
            return res.json();
        },
        onSuccess: (job) => { qc.setQueryData(backfillKeys.job(orgId || ''), job); },
    });
}
