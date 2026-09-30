/**
 * The one shape every webpage write takes: run the call, tell the screen
 * (its own toast or navigation, passed as handlers), then refresh what the
 * write changed. Refreshing the page's detail key refreshes every part of the
 * page that is on screen, because they all sit under it (api/keys.ts).
 */

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

import { webpageKeys } from '../api/keys';

export interface Handlers<D, V = void> {
    onSuccess?: (data: D, vars: V) => void;
    onError?: (error: Error, vars: V) => void;
}

export interface PageMutationOptions<D, V> {
    handlers?: Handlers<D, V>;
    /** What to refresh after success. Default: the page and the list. */
    refresh?: (id: string) => readonly QueryKey[];
}

const PAGE_AND_LIST = (id: string): readonly QueryKey[] => [webpageKeys.detail(id), webpageKeys.all];

export function usePageMutation<V, D>(
    id: string,
    mutationFn: (vars: V) => Promise<D>,
    { handlers = {}, refresh = PAGE_AND_LIST }: PageMutationOptions<D, V> = {},
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn,
        onSuccess: (data: D, vars: V) => {
            handlers.onSuccess?.(data, vars);
            for (const queryKey of refresh(id)) void queryClient.invalidateQueries({ queryKey });
        },
        onError: handlers.onError,
    });
}
