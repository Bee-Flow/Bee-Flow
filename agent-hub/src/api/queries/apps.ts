// Reads for apps, moved out of components by scripts/rq-codemod.mjs.
// authFetch stays inside queryFn on purpose: the screens' tests mock authFetch.

import { useQuery } from '@tanstack/react-query';
import { authFetch, API_BASE } from '../../utils/helpers';
import { ApiError } from '../client';

export const appsKeys = {
    dataConnectors: (appId: string | null) => ['apps', 'dataConnectors', appId] as const,
};

export function useDataConnectors(appId: string | null) {
    return useQuery<string[], Error>({
        queryKey: appsKeys.dataConnectors(appId),
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(String(appId))}/data/connectors`);
            if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status });
            const body = await res.json().catch(() => null);
            const list: { runAs?: string; integrationId?: string }[] = Array.isArray(body?.connectors) ? body.connectors : [];
            const next = [...new Set(list.filter((c) => c.runAs === 'viewer' && c.integrationId).map((c) => c.integrationId as string))];
            return next;
        },
        staleTime: 0,
        retry: false,
    });
}
