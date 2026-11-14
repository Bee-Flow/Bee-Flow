// The first 200 documents of one knowledge base and the server's count of all
// of them, as the agent wizard's upload dialog lists them. A refused or failed
// read keeps what the dialog showed.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { apiJson } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export interface KbDocumentPage<D> {
    docs: D[];
    total: number;
}

const kbDocumentPageKey = (kbId: string) => ['kb', kbId, 'documents', 'page'] as const;

export function useKbDocumentPageQuery<D>(kbId: string | null) {
    return useQuery<KbDocumentPage<D>, Error>({
        queryKey: kbDocumentPageKey(kbId ?? ''),
        enabled: !!kbId,
        ...READ_ONCE,
        queryFn: async () => {
            type Answer = D[] | { documents?: D[]; items?: D[]; total?: number };
            const data = await apiJson<'GET /api/kb/{id}/documents', Answer>('GET /api/kb/{id}/documents', { params: { id: kbId as string }, query: { limit: '200' } });
            const list = Array.isArray(data) ? data : (data?.documents || data?.items || []);
            const total = !Array.isArray(data) && Number.isFinite(data?.total) ? data.total as number : list.length;
            return { docs: list, total };
        },
    });
}

/** Read one base's page again (after an upload or a delete); resolves once the answer is in. */
export function useReloadKbDocumentPage() {
    const qc = useQueryClient();
    return useCallback((kbId: string) => qc.refetchQueries({ queryKey: kbDocumentPageKey(kbId) }), [qc]);
}
