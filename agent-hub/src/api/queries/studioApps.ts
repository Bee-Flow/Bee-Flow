// App Studio reads that hang off the inspector and the runtime components.
// `authFetch` stays inside queryFn: a non-ok answer or a network failure is an
// empty list for the editor, never an exception.

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** The knowledge bases an AI action may ground in; `null` while the read is in flight. */
export function useStudioKnowledgeBases<T>(): T[] | null {
    const query = useQuery<T[], Error>({
        queryKey: ['studio-apps', 'knowledge-bases'],
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/kb`);
                const body = r.ok ? await r.json() : [];
                return Array.isArray(body) ? body : (body?.knowledge_bases || body?.kbs || []);
            } catch {
                return [];
            }
        },
        staleTime: 0,
        retry: false,
    });
    return query.data ?? null;
}

export interface StudioLargeDataset {
    id: string;
    name: string;
    status: string;
    build: string;
    variantCount: number;
}

/**
 * The app's ready large datasets (the "pick an existing one" list). A failed read
 * leaves whatever the picker already had: the query throws, the previous data stays.
 */
export function useStudioLargeDatasets(appId: string | null | undefined, enabled: boolean) {
    const query = useQuery<StudioLargeDataset[], Error>({
        queryKey: ['studio-apps', 'large-datasets', appId ?? null],
        enabled: enabled && Boolean(appId),
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId as string)}/large-datasets`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !Array.isArray(data.datasets)) throw new Error('large datasets unavailable');
            return data.datasets.filter((d: { status: string }) => d.status === 'ready');
        },
        staleTime: 0,
        retry: false,
    });
    const { refetch } = query;
    const refresh = useCallback(() => { void refetch(); }, [refetch]);
    return { existing: query.data ?? NO_DATASETS, refresh };
}

const NO_DATASETS: StudioLargeDataset[] = [];

/**
 * One App Studio runtime request whose caller reads the status itself (404 is
 * "empty", 409 carries a typed code, a blob is turned into an object URL it must
 * revoke). `authFetch` unchanged, so mocks of it and the demo transport still apply.
 */
export function studioAppFetch(url: string, init?: Parameters<typeof authFetch>[1]): Promise<Response> {
    return init === undefined ? authFetch(url) : authFetch(url, init);
}
