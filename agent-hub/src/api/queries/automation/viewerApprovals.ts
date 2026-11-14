// The signed-in viewer's own approvals, as an app's approval list shows them:
// GET /api/automation/approvals with the viewer's session (scope `mine` is the
// server's law; the app only narrows by status and, optionally, by app).

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../typedRequest';

/** How often the list is asked again: the platform's bell cadence. */
const REFRESH_MS = 30_000;

interface ViewerApprovalsFilter {
    /** Comma-separated statuses, or null for every status. */
    status: string | null;
    limit: number;
    /** Only the approvals this app started, or null for all of the viewer's. */
    appId: string | null;
}

/** The cache key of one list, for the caller that writes a decided row into it. */
export const viewerApprovalsKey = (filter: ViewerApprovalsFilter) => ['automation', 'approvals', 'viewer', filter.status, filter.limit, filter.appId] as const;

/**
 * The viewer's approvals for one filter, asked again every 30 seconds (polling,
 * deliberately: there is no per-viewer push channel to approvals), in a hidden tab
 * too. A refusal errors with the RefusedError and is not retried; the rows of the
 * answer before it stay in the cache. `client` is the caller's query client (a
 * component that also renders without a provider passes its own).
 */
export function useViewerApprovalsQuery<Row>(filter: ViewerApprovalsFilter, enabled: boolean, client?: QueryClient) {
    return useQuery<Row[], Error>({
        queryKey: viewerApprovalsKey(filter),
        queryFn: async () => {
            const q = new URLSearchParams();
            q.set('scope', 'mine');
            if (filter.status) q.set('status', filter.status);
            q.set('limit', String(filter.limit));
            if (filter.appId) q.set('appId', filter.appId);
            const res = await apiRequest('GET /api/automation/approvals', { query: q });
            const body = (await res.json().catch(() => null)) as { approvals?: unknown } | null;
            return Array.isArray(body?.approvals) ? (body.approvals as Row[]) : [];
        },
        enabled,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: enabled ? REFRESH_MS : false,
        refetchIntervalInBackground: true,
    }, client);
}
