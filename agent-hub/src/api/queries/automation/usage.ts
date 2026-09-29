// Step usage across the organisation — the ONLY place that knows the
// /api/automation/_usage/steps wire contract.
//
// The ribbon's "Frequently used" grid blends this with the per-user history in
// flow/stepUsage.js: the user's own habits say what they reach for, the org
// counts say what works here for somebody who has no habits yet.

import { useQuery } from '@tanstack/react-query';
import { ApiError, apiClient } from '../../client';

/** One row: a stepUsage usage-key ('step:loop', 'action:gmail_send', …) and how often the org used it. */
export interface OrgStepUsage {
    key: string;
    count: number;
}

export const automationUsageKeys = {
    all: ['automation', 'usage'] as const,
    steps: () => [...automationUsageKeys.all, 'steps'] as const,
};

/**
 * Keeps only well-formed rows. A bare kind ('loop') is read as 'step:loop', so
 * a server that counts node types rather than usage-keys still lands.
 */
export function normaliseUsageRows(rows: unknown): OrgStepUsage[] {
    if (!Array.isArray(rows)) return [];
    const out: OrgStepUsage[] = [];
    for (const row of rows) {
        const r = row as { key?: unknown; count?: unknown } | null;
        if (!r || typeof r.key !== 'string' || !r.key) continue;
        const count = Number(r.count);
        if (!Number.isFinite(count) || count <= 0) continue;
        out.push({ key: r.key.includes(':') ? r.key : `step:${r.key}`, count });
    }
    return out;
}

/**
 * 403/404 read as "no org history": an older server without the route, or an
 * account that may not see it. The grid then falls back to personal usage.
 */
async function fetchOrgStepUsage(signal?: AbortSignal): Promise<OrgStepUsage[]> {
    try {
        return normaliseUsageRows(await apiClient.get<unknown>('/api/automation/_usage/steps', { signal, retry: false }));
    } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return [];
        throw e;
    }
}

export function useOrgStepUsageQuery(enabled = true) {
    return useQuery<OrgStepUsage[], Error>({
        queryKey: automationUsageKeys.steps(),
        queryFn: ({ signal }) => fetchOrgStepUsage(signal),
        enabled,
        // Counts over weeks of runs: a minute-old answer is as good as a fresh one.
        staleTime: 5 * 60 * 1000,
    });
}
