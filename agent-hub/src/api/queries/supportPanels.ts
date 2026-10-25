// Reads behind the support drawer and its admin tabs. Each queryFn keeps the
// effect's contract (see the per-hook notes); authFetch stays in here.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

export interface SupportInsights {
    csat: { avg7d: number | null; avg30d: number | null; responseRate?: number; responses: number };
    handling: {
        aiResolved: number;
        staffResolved: number;
        slaBreaches: number;
        total: number;
        avgFirstResponseSecs: number | null;
        avgResolutionSecs: number | null;
    };
}

export interface SupportAiConfig {
    v2Enabled?: boolean;
    autoResolveThreshold?: number | null;
}

/** GET /api/support/insights. Rejects with the server's `error` text (or "Failed") on a non-ok answer. */
export function useSupportInsightsQuery() {
    return useQuery<SupportInsights, Error>({
        queryKey: ['support', 'insights'] as const,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/support/insights`);
            if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
            return res.json();
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /api/support/config. `null` for a non-ok answer (the tab keeps its defaults); a network failure rejects. */
export function useSupportConfigQuery() {
    return useQuery<SupportAiConfig | null, Error>({
        queryKey: ['support', 'config'] as const,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/support/config`);
            return res.ok ? await res.json() : null;
        },
        staleTime: 0,
        retry: false,
    });
}

export interface YouTrackStatus {
    configured?: boolean;
    ok?: boolean;
    host?: string;
    error?: string;
}

/** GET /api/support/youtrack/status. `null` on a non-ok answer or a network failure: the panel degrades to "not connected". */
export function useYouTrackStatusQuery() {
    return useQuery<YouTrackStatus | null>({
        queryKey: ['support', 'youtrackStatus'] as const,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/support/youtrack/status`);
                return res.ok ? await res.json() : null;
            } catch (err) {
                logger.debug('the panel degrades to "not connected"', err);
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}
