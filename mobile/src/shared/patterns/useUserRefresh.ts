/**
 * Pull-to-refresh that spins only for the person's own pull.
 *
 * A RefreshControl bound to `query.isRefetching` spins for every background
 * fetch too: a poll, a focus refetch, an invalidation after a write. On
 * Android that drops the refresh circle in at the top of the screen by itself,
 * every few seconds on a screen that polls (a running run, a meeting being
 * transcribed, a notebook ingesting). This is TanStack Query's "refresh by
 * user" recipe: the flag is local, set when the pull starts and cleared when
 * the promise the pull returned settles.
 *
 * `refresh` returns what it waits for: `() => query.refetch()`, or for a
 * screen made of several queries `() => Promise.all([a.refetch(), b.refetch()])`.
 * The returned `{ refreshing, onRefresh }` fits a RefreshControl, BlockList
 * and GroupedScroll's `refresh` as-is.
 */

import { useState } from 'react';

export interface UserRefresh {
    /** True only while a pull the person started is still running. */
    refreshing: boolean;
    onRefresh: () => void;
}

/**
 * Wait for `refresh`, whatever it returns. A failure is not reported here: a
 * query's refetch resolves either way and shows its error through the query's
 * own state, and the spinner must stop either way.
 */
async function settle(refresh: () => unknown): Promise<void> {
    try {
        await refresh();
    } catch {
        // See above: the screen shows the query's error; this only ends the pull.
    }
}

export function useUserRefresh(refresh: () => unknown): UserRefresh {
    const [refreshing, setRefreshing] = useState(false);
    const onRefresh = () => {
        setRefreshing(true);
        void settle(refresh).finally(() => setRefreshing(false));
    };
    return { refreshing, onRefresh };
}
