/**
 * React Query, tuned for a phone rather than a desktop tab.
 *
 * `retry` deliberately does not retry a 4xx: a 402 (plan limit) or 403 (not
 * entitled) is a settled answer, and retrying it just delays the message and
 * spends the user's data.
 *
 * `networkMode: 'always'`: with React Query's default ('online') a query or a
 * write made while offline is PAUSED — a list with nothing cached then drew
 * its empty state as if it were true ("No approvals yet"), and a Save spun
 * forever. Always running lets the HTTP client answer with its OfflineError,
 * which every error state, banner and toast words as "You are offline".
 * One client for the app's lifetime.
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/core/api/client';

function shouldRetry(failureCount: number, error: unknown): boolean {
    if (error instanceof ApiError && error.status && error.status < 500) return false;
    return failureCount < 2;
}

export function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                gcTime: 10 * 60_000,
                networkMode: 'always',
                retry: shouldRetry,
                // The app is backgrounded constantly; refetching on every return
                // to foreground is what makes it feel live rather than stale.
                refetchOnWindowFocus: true,
                refetchOnReconnect: true,
            },
            mutations: { networkMode: 'always', retry: false },
        },
    });
}

/** The app's client. Module-level so it survives every re-render of the root. */
export const queryClient = createQueryClient();
