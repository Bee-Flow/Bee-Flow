// Reads for knowledgeBases, moved out of components by scripts/rq-codemod.mjs.
// authFetch stays inside queryFn on purpose: the screens' tests mock authFetch.

import { useQuery } from '@tanstack/react-query';
import { authFetch, API_BASE } from '../../utils/helpers';
import { ApiError } from '../client';

const knowledgeBasesKeys = {
    n8nIngestible: (kbInputMode: string) => ['knowledgeBases', 'n8nIngestible', kbInputMode] as const,
};

export function useN8nIngestible(kbInputMode: string) {
    return useQuery<unknown[], Error>({
        queryKey: knowledgeBasesKeys.n8nIngestible(kbInputMode),
        enabled: kbInputMode === 'n8n',
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/kb/n8n/ingestible`);
            if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status });
            return await res.json();
        },
        staleTime: 0,
        retry: false,
    });
}
