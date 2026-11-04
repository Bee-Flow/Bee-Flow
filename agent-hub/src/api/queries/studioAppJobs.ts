// The background jobs of an App Studio app that this viewer started and that are still
// running (server: routes/studioAppsRun.js GET /:id/actions/jobs?active=1). The run surface
// reads it once so a job started before a reload, or in another tab, shows its progress
// again; following each job is the runner's poll (runtime/actionRunner/backgroundRun.ts).

import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { getAuthed, jobsUrl } from '../actionHttp';
import type { JobView } from '../actionHttp';

export const studioAppJobKeys = {
    active: (appId: string | null, draft: boolean) => ['studioAppJobs', 'active', appId, draft] as const,
};

/** The viewer's running jobs; any failure (a public page, an old server) reads as none. */
export async function fetchActiveJobs(appId: string | null, draft: boolean): Promise<JobView[]> {
    try {
        const res = await getAuthed(`${jobsUrl(appId)}?active=1${draft ? '&draft=1' : ''}`);
        if (!res.ok) return [];
        const body = await res.json() as { jobs?: unknown };
        return Array.isArray(body?.jobs) ? body.jobs as JobView[] : [];
    } catch {
        return [];
    }
}

// Stands in when a surface renders without a QueryClientProvider (a unit test): the
// query is then off and nothing is fetched.
const DETACHED_CLIENT = new QueryClient();

/** Idle without an app id or a QueryClientProvider; read on every mount (a job may have started since), not on focus. */
export function useOptionalActiveActionJobs(appId: string | null, draft: boolean) {
    const client = useContext(QueryClientContext);
    return useQuery<JobView[], Error>({
        queryKey: studioAppJobKeys.active(appId, draft),
        queryFn: () => fetchActiveJobs(appId, draft),
        enabled: !!client && !!appId,
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: false,
    }, client || DETACHED_CLIENT);
}
