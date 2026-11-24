// "It notices what you repeat", for the signed-in person (server/usecases/coworkHabits.mts): on or off, and whether
// the organisation allows it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export interface HabitsState { on: boolean; allowed: boolean }
const KEY = ['cowork', 'habits'] as const;

export function useCoworkHabits() {
    const client = useQueryClient();
    const query = useQuery<HabitsState, Error>({
        queryKey: KEY,
        queryFn: () => apiJson<'GET /api/cowork/habits', HabitsState>('GET /api/cowork/habits'),
        retry: false,
    });
    const set = useMutation<HabitsState, Error, boolean>({
        mutationFn: (on) => apiJson<'PUT /api/cowork/habits', HabitsState>('PUT /api/cowork/habits', { body: { on } }),
        onSuccess: (state) => { client.setQueryData(KEY, state); },
    });
    return { query, set };
}
