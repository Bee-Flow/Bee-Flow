// The imported sanctions lists, for the platform admin: their status and "refresh now".
// The only place that knows the /api/admin/sanctions-lists wire contract
// (server/routes/admin/sanctionsLists.mts).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../typedRequest';

export interface SanctionsListStatus {
    id: string;
    label: string;
    publisher: string;
    infoUrl: string;
    status: 'never' | 'ok' | 'error';
    entityCount: number;
    nameCount: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    replacedAt: string | null;
    lastError: string | null;
}

export interface SanctionsStatusResponse {
    lists: SanctionsListStatus[];
    refreshing: boolean;
    intervalHours: number;
    pepFunctionsVersion: string;
}

export interface SanctionsRefreshResponse {
    /** The pass was asked for; another server replica that is refreshing already finishes it instead. */
    requested: boolean;
    reason?: 'running';
}

const keys = { status: ['admin-sanctions-lists', 'status'] as const };

/** The lists' status; polled every few seconds while a refresh runs. */
export function useSanctionsListStatus() {
    return useQuery<SanctionsStatusResponse, Error>({
        queryKey: keys.status,
        queryFn: ({ signal }) => apiJson<'GET /api/admin/sanctions-lists', SanctionsStatusResponse>('GET /api/admin/sanctions-lists', { init: { signal } }),
        refetchInterval: (q) => (q.state.data?.refreshing ? 5000 : false),
    });
}

export function useRefreshSanctionsLists() {
    const qc = useQueryClient();
    return useMutation<SanctionsRefreshResponse, Error, void>({
        mutationFn: () => apiJson<'POST /api/admin/sanctions-lists/refresh', SanctionsRefreshResponse>('POST /api/admin/sanctions-lists/refresh', { body: {} }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.status }); },
    });
}
