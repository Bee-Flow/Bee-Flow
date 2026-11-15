// Shared React Query client.
//
// All API consumers should pull their queries through this client so we get
// one cache, one set of devtools, and one place to tune retry/staleness.
// Configuration:
//
//   staleTime: 30s         — most domain reads change rarely; this prevents
//                            the "every panel refetches on mount" pattern
//                            that the pre-React-Query code suffered from.
//   gcTime: 5min           — unmounted queries linger in the cache so that
//                            navigating back doesn't refetch.
//   retry: retryUnlessRefused (exp backoff) — up to 2 more tries for a
//                            transient 5xx or a network blip, none for a 4xx.
//   refetchOnWindowFocus: false  — chat UI shouldn't refetch every alt-tab.

import { QueryClient } from '@tanstack/react-query';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../constants/units';

/**
 * A refusal (401 signed out, 403 not allowed, 404 gone, 422 invalid) will not
 * change on a second try: show it at once. 408 and 429 are the two 4xx answers
 * that ask for another try. An error without a numeric `status` (a network
 * failure, a thrown `Error`) gets the two tries, like a 5xx.
 */
export function retryUnlessRefused(failures: number, error: unknown): boolean {
    const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
    const refused = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
    return !refused && failures < 2;
}

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30 * MS_PER_SECOND,
            gcTime: 5 * MS_PER_MINUTE,
            retry: retryUnlessRefused,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
            refetchOnWindowFocus: false,
            refetchOnReconnect: 'always',
        },
        mutations: {
            // Mutations don't retry automatically — callers decide whether
            // the action is idempotent.
            retry: false,
        },
    },
});
