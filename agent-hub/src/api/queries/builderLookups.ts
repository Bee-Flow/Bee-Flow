// Small lookups behind the automation builder's step editors. authFetch stays inside
// queryFn on purpose: the editors' tests mock it.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * The knowledge bases an AI step may use. A refused answer or a failed read is an empty list
 * (the editor then says "none yet"); `undefined` data means still loading.
 */
export function useAiStepKnowledgeBases<T>() {
    return useQuery<T[], Error>({
        queryKey: ['automationBuilder', 'aiStepKnowledgeBases'],
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/kb?context=ai_step`);
                const body = r.ok ? await r.json() : [];
                return Array.isArray(body) ? body : (body?.knowledge_bases || body?.kbs || []);
            } catch {
                return [];
            }
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * The PII detector's health status string. Advisory only: a failed probe yields null,
 * which says nothing rather than claiming the detector is missing.
 */
export function useGuardHealthStatus() {
    return useQuery<string | null, Error>({
        queryKey: ['automationBuilder', 'guardHealth'],
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/guard/health`);
                const b = r.ok ? await r.json() : null;
                return b && typeof b.status === 'string' ? b.status : null;
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}
