// Sharing a cowork with a team (server/usecases/coworkShares.mts): who the owner shared an item with, the items shared
// with me, and one of them read only.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export type ShareRole = 'viewer' | 'approver';
export interface Share { userId: string; role: ShareRole; name?: string }
export interface SharedItem { id: string; ownerId: string; ownerName: string; title: string; role: ShareRole; lastStatus: string | null; lastRunAt: string | null; isActive: boolean }
export interface SharedView {
    role: ShareRole | 'owner';
    item: { id: string; title: string; prompt: string; repeatInterval: string | null; nextRunAt: string | null; lastStatus: string | null; isActive: boolean; triggerKind: string };
    runs: Array<{ id: string; status: string | null; startedAt: string | null; result: string | null; durationMs: number | null }>;
}

export function useCoworkShares(coworkId: string, enabled: boolean) {
    const client = useQueryClient();
    const key = ['cowork', 'shares', coworkId] as const;
    const query = useQuery<Share[], Error>({
        queryKey: key,
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork/{id}/shares', { shares?: Share[] }>('GET /api/cowork/{id}/shares', { params: { id: coworkId } })).shares ?? [],
        retry: false,
    });
    const save = useMutation<Share[], Error, Share[]>({
        mutationFn: async (shares) => (await apiJson<'PUT /api/cowork/{id}/shares', { shares?: Share[] }>('PUT /api/cowork/{id}/shares', {
            params: { id: coworkId }, body: { shares: shares.map(({ userId, role }) => ({ userId, role })) },
        })).shares ?? [],
        onSuccess: (shares) => { client.setQueryData(key, shares); },
    });
    return { query, save };
}

export function useSharedWithMe() {
    return useQuery<SharedItem[], Error>({
        queryKey: ['cowork', 'shared'],
        queryFn: async () => (await apiJson<'GET /api/cowork/shared', { items?: SharedItem[] }>('GET /api/cowork/shared')).items ?? [],
        staleTime: 30_000,
        retry: false,
    });
}

export function useSharedItem(id: string | null) {
    return useQuery<SharedView, Error>({
        queryKey: ['cowork', 'shared', id],
        enabled: !!id,
        queryFn: () => apiJson<'GET /api/cowork/shared/{id}', SharedView>('GET /api/cowork/shared/{id}', { params: { id: String(id) } }),
        retry: false,
    });
}
