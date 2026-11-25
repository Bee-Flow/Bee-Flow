// How a cowork starts, over /api/cowork/:id/start (server/usecases/coworkStart.mts): the clock, or an event.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export type StartKind = 'schedule' | 'app_event' | 'after_cowork' | 'webhook' | 'row' | 'file';

export interface StartState {
    kind: StartKind;
    after: { id: string; title: string } | null;
    datatableId: string | null;
    inFolder: string | null;
    hasAddress: boolean;
}

export type StartChoice =
    | { kind: 'schedule' }
    | { kind: 'after_cowork'; scheduleId: string }
    | { kind: 'webhook' }
    | { kind: 'row'; datatableId: string }
    | { kind: 'file'; inFolder: string };

/** A webhook's address, shown once. */
export interface HookAddress { url: string; token: string }

interface Table { id: string; name?: string }

export function useCoworkStart(coworkId: string, enabled: boolean) {
    const client = useQueryClient();
    const key = ['cowork', 'start', coworkId] as const;
    const query = useQuery<StartState, Error>({
        queryKey: key,
        enabled,
        queryFn: () => apiJson<'GET /api/cowork/{id}/start', StartState>('GET /api/cowork/{id}/start', { params: { id: coworkId } }),
        retry: false,
    });
    const choose = useMutation<StartState & { address: HookAddress | null }, Error, StartChoice>({
        mutationFn: (choice) => apiJson<'PUT /api/cowork/{id}/start', StartState & { address: HookAddress | null }>('PUT /api/cowork/{id}/start', { params: { id: coworkId }, body: choice }),
        // The plan's approval went with the change: the plan card and the list read again.
        onSuccess: (state) => { client.setQueryData(key, state); void client.invalidateQueries({ queryKey: ['cowork'] }); },
    });
    return { query, choose };
}

/** The tables the owner can read, for "when rows of a table change". */
export function useReadableTables(enabled: boolean) {
    return useQuery<Table[], Error>({
        queryKey: ['cowork', 'start-tables'],
        enabled,
        queryFn: async () => (await apiJson<'GET /api/datatables', { datatables?: Table[] }>('GET /api/datatables')).datatables ?? [],
        retry: false,
    });
}

/** The owner's own items, for "after another cowork". */
export function useOwnCoworks(enabled: boolean) {
    return useQuery<Array<{ id: string; title?: string }>, Error>({
        queryKey: ['cowork', 'start-items'],
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork', { items?: Array<{ id: string; title?: string }> }>('GET /api/cowork')).items ?? [],
        retry: false,
    });
}
