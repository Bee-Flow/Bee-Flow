/**
 * The runner's HTTP calls, in one place: the v1 /run POST and its poll, the
 * /step and /step/stream POSTs, and an attachment download. The callers own
 * what a status or a body means; this module only speaks to the server.
 */
import { API_BASE, authFetch } from '../utils/helpers';

/** The base URL of one app's action routes. */
export function actionsUrl(appId: string | null): string {
    return `${API_BASE}/api/studio-apps/${encodeURIComponent(String(appId))}/actions`;
}

/** A JSON POST; `deadlineMs` aborts it with a TimeoutError when given. */
export function postJson(url: string, body: unknown, deadlineMs?: number): Promise<Response> {
    return authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(deadlineMs ? { signal: AbortSignal.timeout(deadlineMs) } : {}),
    });
}

/**
 * A JSON POST that outlives the page (fetch keepalive): the run log's end report, sent as a
 * sequence settles, also when the viewer navigates away right after.
 */
export function postKeepalive(url: string, body: unknown): Promise<Response> {
    return authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
    });
}

/** A plain authenticated GET (a run's state, an attachment's bytes). */
export function getAuthed(url: string): Promise<Response> {
    return authFetch(url);
}

/** The attachment route a download_file step reads, so the viewer's access is checked. */
export function attachmentUrl(appId: string | null, fileId: string): string {
    return `${API_BASE}/api/studio-apps/${encodeURIComponent(String(appId))}/data/attachments/${encodeURIComponent(fileId)}`;
}

/** Where a background action's job lives: …/actions/jobs[/<jobId>]. */
export function jobsUrl(appId: string | null, jobId?: string): string {
    return `${actionsUrl(appId)}/jobs${jobId ? `/${encodeURIComponent(jobId)}` : ''}`;
}

/** The progress of a background job, as the server reports it. */
export interface JobProgress {
    stepIndex: number | null;
    kind: string | null;
    executed: number;
    /** The text of the action's progressVar. */
    message: string | null;
    loop: { index: number; count: number } | null;
    /** 'budget' while the job waits for the per-minute step budget; on a job on hold what it waits for ('timer', 'approval', 'resume'). */
    waiting: string | null;
}

/** A deferred toast or refresh the job recorded; the browser replays it at the end. */
export interface JobEffect {
    kind: 'toast' | 'refresh' | string;
    message?: string;
    tone?: string;
    tableId?: string;
    datasetId?: string;
}

/** One background job (GET …/actions/jobs/:jobId). Additive: unknown fields are ignored. */
export interface JobView {
    jobId: string;
    actionId: string;
    status: 'running' | 'paused' | 'success' | 'error' | 'interrupted' | 'cancelled' | 'refused' | string;
    progress: JobProgress;
    result?: unknown;
    vars?: Record<string, unknown>;
    effects?: JobEffect[];
    error: string | null;
    errorStep: { path?: string; kind?: string; stepIndex?: number | null } | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    /** A job on hold (status 'paused'): when the server continues it by itself; null when something has to resume it. */
    wakeAt?: string | null;
    /** A job on hold: what it waits for besides time (e.g. 'approval'). */
    waitKind?: string | null;
}

/** Cancel a job: a running one stops before its next step, one on hold ends at once. Answers the job. */
export function cancelJob(appId: string | null, jobId: string): Promise<Response> {
    return authFetch(`${jobsUrl(appId, jobId)}/cancel`, { method: 'POST' });
}
