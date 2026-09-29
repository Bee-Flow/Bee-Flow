// Studio counts — the ONLY place that knows the /api/studio/counts wire
// contract.
//
// ONE request, not nine list fetches: the server counts each kind with that
// kind's own scoping and OMITS every key the caller may not see (it never
// 403s as a whole — it would be an entitlement oracle otherwise). A key that
// is absent renders as no count at all.
//
// `authFetch` rather than `apiClient`: a non-ok response here is a state the
// rail renders ("could not be read"), and the consuming screens mock
// `authFetch` with a bare `{ ok, status, json }`.

import { useQuery } from '@tanstack/react-query';
import { useDocumentFocused } from './documentFocus';
import { API_BASE, authFetch } from '../../utils/helpers';

export const STUDIO_COUNTS_POLL_MS = 30_000;

/** Section key → item count. A section the caller may not see is absent. */
export type StudioCounts = Record<string, number>;

export interface StudioCountsPayload {
    counts: StudioCounts | null;
    makers: number | null;
}

export const studioCountsKeys = {
    all: ['studio-counts'] as const,
};

/** Normalise one response body. Exported for the test; tolerant of junk. */
export function parseStudioCounts(body: unknown): StudioCountsPayload {
    const raw = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const rawCounts = raw && typeof raw.counts === 'object' && raw.counts !== null
        ? raw.counts as Record<string, unknown>
        : null;
    let counts: StudioCounts | null = null;
    if (rawCounts) {
        counts = {};
        for (const [key, value] of Object.entries(rawCounts)) {
            if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
        }
    }
    const makers = typeof raw?.makers === 'number' && Number.isFinite(raw.makers) ? raw.makers : null;
    return { counts, makers };
}

export async function fetchStudioCounts(signal?: AbortSignal): Promise<StudioCountsPayload> {
    const res = await authFetch(`${API_BASE}/api/studio/counts`, { signal });
    // A read that does not land is REPORTED, not swallowed. The rail draws the
    // same nothing either way, but a screen that says "the number is not in
    // yet" over a 500 is promising something that is not coming.
    if (!res.ok) throw new Error(`studio counts ${res.status}`);
    return parseStudioCounts(await res.json());
}

export interface UseStudioCountsQueryOptions {
    enabled?: boolean;
    /** false = fetch ONCE (plus the focus catch-up), no interval. */
    poll?: boolean;
}

export function useStudioCountsQuery({ enabled = true, poll = true }: UseStudioCountsQueryOptions = {}) {
    const focused = useDocumentFocused();
    return useQuery<StudioCountsPayload, Error>({
        queryKey: studioCountsKeys.all,
        queryFn: ({ signal }) => fetchStudioCounts(signal),
        // A screen that mounts in a background tab reads nothing until the tab
        // is looked at — including the single read of `poll: false`.
        enabled: enabled && focused,
        // The rail and Studio Home read the same body; one of them polling is
        // enough, and the server caches it for 60s per (org, user) anyway.
        refetchInterval: poll ? STUDIO_COUNTS_POLL_MS : false,
        refetchOnWindowFocus: true,
        staleTime: STUDIO_COUNTS_POLL_MS,
        retry: false,
    });
}
