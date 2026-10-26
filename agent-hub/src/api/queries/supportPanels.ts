// Reads behind the support drawer and its admin tabs. Each queryFn keeps the
// effect's contract (see the per-hook notes); authFetch stays in here.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { readOrNull } from './refusableRead';
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

const supportAdminKeys = {
    tags: ['support', 'admin-tags'] as const,
    canned: ['support', 'admin-canned'] as const,
    sla: ['support', 'admin-sla'] as const,
};

/** GET /api/support/tags (the tag taxonomy tab). */
export function useSupportTagTaxonomyQuery<T>() {
    return useQuery<T[] | null, Error>({
        queryKey: supportAdminKeys.tags,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ tags?: T[] }>(`${API_BASE}/api/support/tags`, signal);
            return body ? body.tags || [] : null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /api/support/canned (the canned responses tab). */
export function useSupportCannedResponsesQuery<T>() {
    return useQuery<T[] | null, Error>({
        queryKey: supportAdminKeys.canned,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ responses?: T[] }>(`${API_BASE}/api/support/canned`, signal);
            return body ? body.responses || [] : null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /api/support/sla-policies, keyed by priority (the SLA tab). */
export function useSupportSlaPoliciesQuery<T extends { priority: string }>() {
    return useQuery<Record<string, T> | null, Error>({
        queryKey: supportAdminKeys.sla,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ policies?: T[] }>(`${API_BASE}/api/support/sla-policies`, signal);
            if (!body) return null;
            const map: Record<string, T> = {};
            for (const p of body.policies || []) map[p.priority] = p;
            return map;
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET the issues linked to one ticket; a refusal reads as null (the panel keeps what it shows). */
export function useLinkedIssuesQuery<T>(threadId: string | null) {
    return useQuery<T[] | null, Error>({
        queryKey: ['support', 'linked-issues', threadId] as const,
        enabled: !!threadId,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ issues?: T[] }>(`${API_BASE}/api/support/threads/${threadId}/issues`, signal);
            return body ? body.issues || [] : null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The cache key of a ticket's linked issues, for a caller that writes the answer of a refresh into it. */
export const linkedIssuesKey = (threadId: string | null) => ['support', 'linked-issues', threadId] as const;

/** The audit trail of one ticket in the Support studio (newest first); a refusal reads as no events. */
export function useTicketEventsQuery<E>(threadId: string) {
    return useQuery<E[], Error>({
        queryKey: ['support', 'ticket-events', threadId] as const,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ events?: unknown }>(`${API_BASE}/api/support-inbox/threads/${threadId}/events`, signal);
            return Array.isArray(body?.events) ? body.events as E[] : [];
        },
        staleTime: 0,
        retry: false,
    });
}
