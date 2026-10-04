// The builder's Runs tab (handoff 5, artboard 5c): the ONLY place that knows
// the run-list, facet, run-detail, retry and remind wire contracts for it.
//
// Field names follow the handoff-5 server contract (outcome, stepStatuses,
// startedBy, howStarted, isTest). Every one of them is optional here: rows
// written before the migration carry none of them, and the renderers fall
// back to status/summary/error/triggerKind.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { AutomationRequestError } from './http';

export type RunOutcomeCode =
    | 'success' | 'stopped_at' | 'waiting_approval' | 'waiting_form' | 'waiting_confirm' | 'cancelled';

export interface RunOutcome {
    code: RunOutcomeCode | string;
    params?: Record<string, unknown> | null;
    /** The server's English sentence, for codes this build cannot phrase. */
    text?: string | null;
}

export interface RunRowData {
    id: string;
    automationId?: string;
    version?: number | null;
    status?: string | null;
    mode?: string | null;
    triggerKind?: string | null;
    triggerPayload?: unknown;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    error?: string | null;
    errorClass?: string | null;
    summary?: string | null;
    outcome?: RunOutcome | null;
    stepsTotal?: number | null;
    stepsDone?: number | null;
    stepStatuses?: string[] | null;
    startedBy?: { id?: string | null; name?: string | null } | null;
    howStarted?: string | null;
    isTest?: boolean;
    awaitingStepId?: string | null;
    parentRunId?: string | null;
    /** The pending approval a waiting run waits on (rows with status awaiting_*). */
    approvalId?: string | null;
}

export interface RunStepRecord {
    stepId: string;
    parentStepId?: string | null;
    stepType?: string | null;
    status?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    input?: unknown;
    output?: unknown;
    error?: string | null;
    errorClass?: string | null;
}

export interface RunStepsPayload {
    steps: RunStepRecord[];
    definition: unknown;
}

/** The status filter segment. */
export type RunStatusFilter = 'all' | 'failed' | 'waiting' | 'running';
/** The period dropdown, in hours (0 = everything the server keeps). */
export type RunPeriod = 24 | 168 | 720 | 0;

export interface RunListFilters {
    status: RunStatusFilter;
    period: RunPeriod;
    q: string;
    showTests: boolean;
}

export interface RunFacetCounts {
    all: number;
    failed: number;
    waiting: number;
    running: number;
}

const STATUS_SETS: Record<Exclude<RunStatusFilter, 'all'>, string[]> = {
    failed: ['error'],
    waiting: ['awaiting_approval', 'awaiting_confirm', 'awaiting_form'],
    running: ['running', 'queued'],
};

export const runsKeys = {
    all: ['automation-runs'] as const,
    list: (automationId: string, f: RunListFilters) => ['automation-runs', 'list', automationId, f] as const,
    facets: (automationId: string, f: Omit<RunListFilters, 'status'>) =>
        ['automation-runs', 'facets', automationId, f] as const,
    run: (runId: string) => ['automation-runs', 'run', runId] as const,
    steps: (runId: string) => ['automation-runs', 'steps', runId] as const,
};

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await authFetch(`${API_BASE}/api/automation${path}`, { signal });
    if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
    return await res.json() as T;
}

/** A refused request, with the server's error code (e.g. remind_rate_limited). */
export { AutomationRequestError as RunsRequestError };

// The routes these call take no body: none is sent.
async function postJson<T>(path: string): Promise<T> {
    const res = await authFetch(`${API_BASE}/api/automation${path}`, { method: 'POST' });
    if (!res.ok) {
        const body = await res.json().catch(() => null) as { code?: unknown } | null;
        throw new AutomationRequestError(`POST ${path} ${res.status}`, res.status, typeof body?.code === 'string' ? body.code : null);
    }
    return await res.json().catch(() => ({})) as T;
}

/** The `since` for a period, or undefined for "all". Exported for the test. */
export function sinceFor(period: RunPeriod, now: number = Date.now()): string | undefined {
    if (!period) return undefined;
    return new Date(now - period * 3600 * 1000).toISOString();
}

/** The list query string for one filter set. Exported for the test. */
export function runListQuery(f: RunListFilters, now: number = Date.now(), limit = 100): string {
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    if (f.status !== 'all') p.set('status', STATUS_SETS[f.status].join(','));
    const since = sinceFor(f.period, now);
    if (since) p.set('since', since);
    // Test-button runs, dry runs and step runs are all flagged isTest.
    if (!f.showTests) p.set('tests', 'exclude');
    const q = f.q.trim();
    if (q) p.set('q', q);
    return `?${p.toString()}`;
}

/** Status facet map → the four segment counts. Exported for the test. */
export function facetCounts(byStatus: Record<string, number> | null | undefined): RunFacetCounts {
    const s = byStatus || {};
    const sum = (keys: string[]) => keys.reduce((n, k) => n + (Number(s[k]) || 0), 0);
    return {
        all: Object.values(s).reduce((n, v) => n + (Number(v) || 0), 0),
        failed: sum(STATUS_SETS.failed),
        waiting: sum(STATUS_SETS.waiting),
        running: sum(STATUS_SETS.running),
    };
}

export function useRunList(automationId: string | null, filters: RunListFilters, enabled: boolean) {
    return useQuery<RunRowData[], Error>({
        queryKey: runsKeys.list(automationId || '', filters),
        queryFn: async ({ signal }) => {
            const body = await getJson<{ runs?: RunRowData[] }>(
                `/${encodeURIComponent(automationId as string)}/runs${runListQuery(filters)}`, signal,
            );
            return Array.isArray(body?.runs) ? body.runs : [];
        },
        enabled: enabled && !!automationId,
        staleTime: 10_000,
    });
}

/**
 * The segment counts. GET /:id/runs sends them on its first page, counted
 * with every filter but the status (automation-scoped, so shared viewers and
 * run-only members get their own numbers). Asked for once per period,
 * search and test switch, with a one-row page, so picking a segment does not
 * blank them.
 */
export function useRunFacets(automationId: string | null, filters: RunListFilters, enabled: boolean) {
    const { status: _status, ...rest } = filters;
    return useQuery<RunFacetCounts, Error>({
        queryKey: runsKeys.facets(automationId || '', rest),
        queryFn: async ({ signal }) => {
            const query = runListQuery({ ...rest, status: 'all' }, Date.now(), 1);
            const body = await getJson<{ facets?: Partial<RunFacetCounts> & { byStatus?: Record<string, number> } }>(
                `/${encodeURIComponent(automationId as string)}/runs${query}`, signal,
            );
            const f = body?.facets;
            if (f?.byStatus) return facetCounts(f.byStatus);
            return { all: Number(f?.all) || 0, failed: Number(f?.failed) || 0, waiting: Number(f?.waiting) || 0, running: Number(f?.running) || 0 };
        },
        enabled: enabled && !!automationId,
        staleTime: 10_000,
    });
}

export function useRun(runId: string | null, enabled: boolean) {
    return useQuery<RunRowData, Error>({
        queryKey: runsKeys.run(runId || ''),
        // GET /runs/:id answers { run }.
        queryFn: async ({ signal }) => {
            const body = await getJson<{ run?: RunRowData } | null>(`/runs/${encodeURIComponent(runId as string)}`, signal);
            if (!body?.run) throw new Error('run not found');
            return body.run;
        },
        enabled: enabled && !!runId,
    });
}

export function useRunSteps(runId: string | null, enabled: boolean) {
    return useQuery<RunStepsPayload, Error>({
        queryKey: runsKeys.steps(runId || ''),
        queryFn: async ({ signal }) => {
            const body = await getJson<Partial<RunStepsPayload>>(`/runs/${encodeURIComponent(runId as string)}/steps`, signal);
            return { steps: Array.isArray(body?.steps) ? body.steps : [], definition: body?.definition ?? null };
        },
        enabled: enabled && !!runId,
    });
}

/** What the retry route answers: the new run, or `pending` while it starts. */
export interface RetryResult {
    runId?: string;
    run?: { id?: string } | null;
    pending?: boolean;
}

/** The new run's id from a retry answer, or null while it is still starting. */
export function retriedRunId(res: RetryResult | null | undefined): string | null {
    const id = res?.runId || res?.run?.id;
    return id ? String(id) : null;
}

/** Run again with the same input: works for any finished run. */
export function useRetryRun(automationId: string | null) {
    const qc = useQueryClient();
    return useMutation<RetryResult, Error, string>({
        mutationFn: (runId) => postJson(`/${encodeURIComponent(automationId as string)}/runs/${encodeURIComponent(runId)}/retry`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: runsKeys.all }); },
    });
}

/**
 * Nudge whoever a waiting run waits on. List rows and GET /runs/:id carry the
 * pending approval's id (`approvalId`) on waiting runs.
 */
export function useRemindApproval() {
    const qc = useQueryClient();
    return useMutation<unknown, Error, RunRowData>({
        mutationFn: async (run) => {
            let approvalId = run.approvalId || null;
            if (!approvalId) {
                // A row read before its approval existed: ask the run itself.
                const body = await getJson<{ run?: RunRowData } | null>(`/runs/${encodeURIComponent(run.id)}`).catch(() => null);
                approvalId = body?.run?.approvalId || null;
            }
            if (!approvalId) throw new AutomationRequestError('no pending approval for this run', 404, 'approval_not_found');
            return postJson(`/approvals/${encodeURIComponent(approvalId)}/remind`);
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runsKeys.all }); },
    });
}

/** Refresh everything this tab shows — the live stream's answer to an event. */
export function useInvalidateRuns() {
    const qc = useQueryClient();
    return () => { qc.invalidateQueries({ queryKey: runsKeys.all }); };
}

/**
 * The step a failed run stopped at. The outcome names it on new rows; older
 * rows need the run's step records, read through the same cache the detail
 * pane uses.
 */
export function useFindFailedStep() {
    const qc = useQueryClient();
    return async (run: RunRowData): Promise<string | null> => {
        const named = run.outcome?.params?.stepId;
        if (named != null && named !== '') return String(named);
        try {
            const data = await qc.fetchQuery<RunStepsPayload>({
                queryKey: runsKeys.steps(run.id),
                queryFn: async ({ signal }) => {
                    const body = await getJson<Partial<RunStepsPayload>>(`/runs/${encodeURIComponent(run.id)}/steps`, signal);
                    return { steps: Array.isArray(body?.steps) ? body.steps : [], definition: body?.definition ?? null };
                },
            });
            const failed = data.steps.find(s => !s.parentStepId && (s.status === 'error' || s.status === 'failed'));
            return failed?.stepId || null;
        } catch {
            return null;
        }
    };
}
