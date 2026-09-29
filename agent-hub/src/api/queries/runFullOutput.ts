// The full output of a step whose run-history row holds only the truncation
// sentinel (BFSF-402) — the ONLY place that knows the
// /api/automation/runs/:id/steps/:stepId/full-output contract.
//
// The run history keeps at most 256 KB of a step's output and swaps the rest
// for `{ __truncated__, originalBytes, headSample }`. When the server also kept
// a full copy beside the row, the sentinel names it in `fullOutputRef`
// (server/automation/payloadTruncation.js); without that ref there is nothing
// to fetch, and the head sample is all there is.
//
// Loaded on request, not on render: the copy can be megabytes, and the panel
// that shows a sentinel is often only glanced at.

import { apiClient } from '../client';

export interface FullOutputRef {
    runId: string;
    stepId: string;
    attempts: number;
}

/** The sentinel's pointer to its kept full copy, or null when none was kept. */
export function fullOutputRefOf(value: unknown): FullOutputRef | null {
    if (!value || typeof value !== 'object') return null;
    const sentinel = value as { __truncated__?: unknown; fullOutputRef?: unknown };
    if (sentinel.__truncated__ !== true) return null;
    const ref = sentinel.fullOutputRef as Partial<FullOutputRef> | null | undefined;
    if (!ref || typeof ref !== 'object') return null;
    if (typeof ref.runId !== 'string' || !ref.runId || typeof ref.stepId !== 'string' || !ref.stepId) return null;
    const attempts = Number.isInteger(ref.attempts) && (ref.attempts as number) > 0 ? (ref.attempts as number) : 1;
    return { runId: ref.runId, stepId: ref.stepId, attempts };
}

/**
 * Fetch the kept full output. Resolves to the value; throws an ApiError when
 * the server has none (404) or refuses. Not retried: a 404 stays a 404, and a
 * person clicking the button again is the retry.
 */
export async function fetchRunFullOutput(ref: FullOutputRef, signal?: AbortSignal): Promise<unknown> {
    const path = `/api/automation/runs/${encodeURIComponent(ref.runId)}/steps/${encodeURIComponent(ref.stepId)}/full-output`;
    const body = await apiClient.get<{ output?: unknown }>(path, { query: { attempts: ref.attempts }, signal, retry: false });
    return body?.output ?? null;
}
