/** Support queries. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import { getSupportThread, listMySupportThreads } from '../api/endpoints';
import { supportKeys } from '../api/keys';

export function useMySupportThreads() {
    return useQuery({
        queryKey: supportKeys.threads,
        queryFn: ({ signal }) => listMySupportThreads(signal),
        retry: false,
    });
}

/**
 * One thread, while its sheet is open. While Bee Flow's own responder is
 * drafting, the thread changes without the user doing anything — so it is
 * polled then, and only then.
 */
export function useSupportThread(threadId: string | null) {
    return useQuery({
        queryKey: supportKeys.thread(threadId ?? 'none'),
        queryFn: ({ signal }) =>
            threadId ? getSupportThread(threadId, signal) : Promise.resolve(null),
        enabled: Boolean(threadId),
        refetchInterval: (query) =>
            query.state.data?.thread.status === 'ai_responding' ? 5_000 : false,
    });
}
