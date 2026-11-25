// Handing a cowork to a colleague, over /api/cowork/:id/hand-over (server/usecases/coworkHandOver.mts).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

interface Colleague { id: string; name: string }

/** Who the item can go to; read only when the section is opened. */
export function useCoworkColleagues(coworkId: string, enabled: boolean) {
    return useQuery<Colleague[], Error>({
        queryKey: ['cowork', 'colleagues', coworkId],
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork/{id}/hand-over/colleagues', { colleagues?: Colleague[] }>('GET /api/cowork/{id}/hand-over/colleagues', { params: { id: coworkId } })).colleagues ?? [],
        retry: false,
    });
}

/** Hand it over; the list is read again, and this item is gone from it. */
export function useCoworkHandOver(coworkId: string) {
    const client = useQueryClient();
    return useMutation<{ itemId: string }, Error, string>({
        mutationFn: (toUserId) => apiJson<'POST /api/cowork/{id}/hand-over', { itemId: string }>('POST /api/cowork/{id}/hand-over', { params: { id: coworkId }, body: { toUserId } }),
        onSuccess: () => client.invalidateQueries({ queryKey: ['cowork'] }),
    });
}
