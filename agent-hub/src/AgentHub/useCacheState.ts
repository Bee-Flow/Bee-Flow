import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * A `setState`-shaped writer for a query's cache entry: the hub's handlers
 * edit a list optimistically (`setConversations(prev => prev.filter(...))`)
 * and the query stays the one copy of the list. The entry is ['hub', scope] or
 * ['hub', scope, id]; `fallback` is the value a functional update starts from
 * while the entry has no data yet. The setter keeps its identity while the
 * scope and id do, like a useState setter.
 */
export function useCacheSetter<T>(scope: string, id: string | null, fallback: T): Dispatch<SetStateAction<T>> {
    const queryClient = useQueryClient();
    const key = useMemo(() => (id === null ? ['hub', scope] : ['hub', scope, id]), [scope, id]);
    return useCallback((next) => {
        queryClient.setQueryData<T>(key, (prev) => (typeof next === 'function' ? (next as (p: T) => T)(prev ?? fallback) : next));
    }, [queryClient, key, fallback]);
}
