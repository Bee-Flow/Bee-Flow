// One opened task (components/cowork/task/CoworkTaskView.tsx): the item itself, read on its own so the sheet needs
// nothing from the page, what its owner does with it (run now, pause, delete, a new budget or a change), and what it
// cost in AI this month. Every change reads Cowork again (keys under 'cowork'), so the list, Home and the sheet agree.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, type ApiBody } from './typedRequest';
import { ApiError } from './client';
import type { CoworkItem } from './cowork.types';

/** How often an item that is on the go is read again, and how often at most in a row. */
const LIVE_POLL_MS = 4000;
const LIVE_POLLS = 150;

const coworkItemKey = (id: string) => ['cowork', 'item', id] as const;

/** The item, or null when it is not the reader's own (gone, or someone else's: shared with them, or not at all). */
export function useCoworkItem(id: string) {
    return useQuery<CoworkItem | null, Error>({
        queryKey: coworkItemKey(id),
        queryFn: async () => {
            try {
                return await apiJson<'GET /api/cowork/{id}', CoworkItem>('GET /api/cowork/{id}', { params: { id } });
            } catch (e) {
                if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
                throw e;
            }
        },
        staleTime: 0,
        retry: false,
        refetchInterval: (query) => (query.state.data?.lastStatus === 'running' && query.state.dataUpdateCount < LIVE_POLLS ? LIVE_POLL_MS : false),
    });
}

export type CoworkItemChange = ApiBody<'PUT /api/cowork/{id}'>;

/** What the owner does with the item. Each answer reads Cowork again. */
export function useCoworkItemActions(id: string) {
    const client = useQueryClient();
    const settle = () => client.invalidateQueries({ queryKey: ['cowork'] });
    const params = { id };
    return {
        runNow: useMutation<unknown, Error, void>({ mutationFn: () => apiJson('POST /api/cowork/{id}/run-now', { params, body: {} }), onSuccess: settle }),
        toggle: useMutation<unknown, Error, void>({ mutationFn: () => apiJson('POST /api/cowork/{id}/toggle', { params, body: {} }), onSuccess: settle }),
        remove: useMutation<unknown, Error, void>({ mutationFn: () => apiJson('DELETE /api/cowork/{id}', { params }), onSuccess: settle }),
        change: useMutation<unknown, Error, CoworkItemChange>({ mutationFn: (body) => apiJson('PUT /api/cowork/{id}', { params, body }), onSuccess: settle }),
    };
}

/** One thing a task remembers from one run to the next (server usecases/coworkMemory.mts). */
export interface TaskMemory { id: string; text: string; at: string | null }

/** What the task remembers, read when its row is opened; clearing it can be undone. */
export function useCoworkMemory(id: string, enabled: boolean) {
    const client = useQueryClient();
    const key = ['cowork', 'memory', id] as const;
    const query = useQuery<TaskMemory[], Error>({
        queryKey: key,
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork/{id}/memory', { memories?: TaskMemory[] }>('GET /api/cowork/{id}/memory', { params: { id } })).memories ?? [],
        retry: false,
    });
    const settle = () => client.invalidateQueries({ queryKey: key });
    const clear = useMutation<{ cleared: string[] }, Error, void>({
        mutationFn: () => apiJson<'POST /api/cowork/{id}/memory/clear', { cleared: string[] }>('POST /api/cowork/{id}/memory/clear', { params: { id }, body: {} }),
        onSuccess: settle,
    });
    const restore = useMutation<unknown, Error, string[]>({
        mutationFn: (ids) => apiJson('POST /api/cowork/{id}/memory/restore', { params: { id }, body: { ids } }),
        onSuccess: settle,
    });
    return { query, clear, restore };
}

interface MonthCost { byCurrency: Record<string, number>; calls: number }

/** What the item cost in AI this calendar month, in euros; null when it could not be read. */
export function useCoworkMonthCost(id: string, enabled: boolean) {
    return useQuery<number | null, Error>({
        queryKey: ['cowork', 'month-cost', id],
        enabled,
        queryFn: async () => {
            const stats = await apiJson<'GET /api/cowork/{id}/stats', { costThisMonth?: MonthCost | null }>('GET /api/cowork/{id}/stats', { params: { id } });
            const euros = stats.costThisMonth?.byCurrency?.EUR;
            return typeof euros === 'number' ? euros : stats.costThisMonth ? 0 : null;
        },
        retry: false,
    });
}
