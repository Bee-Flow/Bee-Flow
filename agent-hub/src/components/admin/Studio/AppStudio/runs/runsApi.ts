// The run log of an app (server: routes/studioApps/runLog.js): the ONLY place that knows its
// wire contract. Owner only; people come back by display name, never by e-mail address.
//
//   const runs = useRunList(api, appId, filters);   // infinite list, newest first
//   const detail = useRunDetail(api, appId, runId);  // one run with its steps

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, request } from '@/api/mutate';
import type { WaitingFor } from '@/api/actionHttp';

type RunStatus = 'running' | 'paused' | 'success' | 'error' | 'interrupted' | 'cancelled' | 'refused';
type RunOrigin = 'click' | 'public' | 'mcp' | 'test' | 'background' | 'mailbox_hook' | 'trigger';

export interface RunActor {
    kind: 'owner' | 'user' | 'visitor' | 'system';
    isYou: boolean;
    userId?: string;
    name?: string | null;
}

interface RunAi {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    costByCurrency: Record<string, number>;
}

export interface RunSummary {
    id: string;
    actionId: string;
    origin: RunOrigin | string;
    status: RunStatus | string;
    endedBy: string | null;
    draft: boolean;
    dryRun: boolean;
    definitionVersion: number | null;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    stepCount: number;
    failedSteps: number;
    handledErrors: number;
    truncated: boolean;
    tracked: boolean;
    error: string | null;
    errorCode: string | null;
    errorStep: { path?: string; kind?: string; stepIndex?: number | null; actionId?: string | null } | null;
    ai: RunAi;
    actor: RunActor;
    /** A run on hold only: what it waits for. */
    waiting?: RunWaiting;
}

/** What a run on hold waits for, as the run log reads it from the server. */
export interface RunWaiting { kind: string | null; wakeAt: string | null; waitingFor: WaitingFor | null }
/** What started a run a record trigger started: the change, never its values. */
export interface RunStartedBy { kind: string; event: string; tableId: string; rowId: string; by: string; depth?: number }

interface StepAi {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    model: string | null;
    tier: string | null;
    cost: number | null;
    currency: string | null;
}

export interface RunStep {
    seq: number;
    path: string;
    kind: string;
    actionId: string | null;
    stepIndex: number | null;
    iteration: number | null;
    status: string;
    durationMs: number;
    startedAt: string | null;
    error: string | null;
    errorCode: string | null;
    attempts: number | null;
    handled: boolean;
    mocked: boolean;
    ai: StepAi | null;
}

export interface RunActors {
    users: Array<{ userId: string; name: string | null; runs: number }>;
    visitors: boolean;
    system: boolean;
}

export interface RunPage {
    runs: RunSummary[];
    nextCursor: string | null;
    retentionDays: number;
    actors?: RunActors;
}

export interface RunFilters {
    actionId?: string;
    status?: string;
    /** me | others | visitors | system | a user id */
    user?: string;
    /** Comma list; empty = every origin. */
    origin?: string;
}

export interface RunsApi {
    list(appId: string, filters: RunFilters, cursor: string | null): Promise<RunPage>;
    get(appId: string, runId: string): Promise<{ run: RunSummary; steps: RunStep[]; startedBy?: RunStartedBy }>;
    /** Cancel a background run that is running or on hold; answers its status after the request ('running': it stops before its next step). */
    cancel?(appId: string, runId: string): Promise<{ status: string }>;
}

function query(filters: RunFilters, cursor: string | null): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (typeof v === 'string' && v) q.set(k, v);
    if (cursor) q.set('cursor', cursor);
    const s = q.toString();
    return s ? `?${s}` : '';
}

export const runsApi: RunsApi = {
    async list(appId, filters, cursor) {
        const res = await request(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/runs${query(filters, cursor)}`);
        return (await res.json()) as RunPage;
    },
    async get(appId, runId) {
        const res = await request(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/runs/${encodeURIComponent(runId)}`);
        return (await res.json()) as { run: RunSummary; steps: RunStep[]; startedBy?: RunStartedBy };
    },
    async cancel(appId, runId) {
        const res = await request(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions/jobs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        return (await res.json()) as { status: string };
    },
};

const runKeys = {
    list: (appId: string, filters: RunFilters) => ['studio-app-runs', appId, filters] as const,
    detail: (appId: string, runId: string) => ['studio-app-run', appId, runId] as const,
};

export function useRunList(api: RunsApi, appId: string, filters: RunFilters) {
    return useInfiniteQuery({
        queryKey: runKeys.list(appId, filters),
        queryFn: ({ pageParam }) => api.list(appId, filters, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor,
        enabled: !!appId,
        staleTime: 10_000,
        retry: false,
    });
}

/** Cancel one run, then read the run log again (the list and the run). */
export function useCancelRun(api: RunsApi, appId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (runId: string) => (api.cancel ? api.cancel(appId, runId) : Promise.reject(new Error('cancel is not available'))),
        onSuccess: async (_out, runId) => {
            await Promise.all([
                client.invalidateQueries({ queryKey: ['studio-app-runs', appId] }),
                client.invalidateQueries({ queryKey: runKeys.detail(appId, runId) }),
            ]);
        },
    });
}

export function useRunDetail(api: RunsApi, appId: string, runId: string | null) {
    return useQuery({
        queryKey: runKeys.detail(appId, runId ?? ''),
        queryFn: () => api.get(appId, runId as string),
        enabled: !!appId && !!runId,
        staleTime: 10_000,
        retry: false,
    });
}
