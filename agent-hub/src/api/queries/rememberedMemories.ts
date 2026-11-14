// What the server saved from one chat turn: asked a few times after the answer
// ended, because extraction runs after it.

import { useQuery } from '@tanstack/react-query';
import { fetchRecentMemories, type RecentMemory } from '../memoryApi';
import { logger } from '../../utils/logger';

/** The wait before each ask: the first counts from the start of the read, each later one from the previous answer. */
const REMEMBERED_POLL_DELAYS_MS: readonly number[] = [2000, 4000, 9000];

/** The cache key of one turn's lookups, for the caller that drops them when the turn is left. */
export const rememberedMemoriesKey = (conversationId: string, since: string) => ['memory', 'recent', conversationId, since] as const;

export interface RememberedMemoriesRead {
    /** The memories of the last answer (empty while nothing was found). */
    found: RecentMemory[];
    /** True once something was found or every ask is used up. */
    done: boolean;
}

/** One turn's lookups so far: the last answer and how many times the server was asked. */
interface Lookups { items: RecentMemory[]; asks: number }

const NOT_ASKED: Lookups = { items: [], asks: 0 };

/**
 * GET /agents/memory/recent for one turn, while `enabled`: never at once, but after
 * each wait of REMEMBERED_POLL_DELAYS_MS until an answer has items or the waits run
 * out. A failed lookup counts as nothing yet. The asks go on in a hidden tab, like
 * the timers they replace.
 */
export function useRememberedMemoriesPoll(conversationId: string, since: string, enabled: boolean): RememberedMemoriesRead {
    const { data, isFetching } = useQuery({
        queryKey: rememberedMemoriesKey(conversationId, since),
        queryFn: async ({ signal, client, queryKey }): Promise<Lookups> => {
            const asks = (client.getQueryData<Lookups>(queryKey)?.asks ?? 0) + 1;
            try {
                return { items: await fetchRecentMemories(conversationId, since, signal), asks };
            } catch (err) {
                if (signal.aborted) throw err;
                logger.debug('A failed lookup is the same as nothing yet: try the next time.', err);
                return { items: [], asks };
            }
        },
        enabled,
        // Starts as "not asked yet" and never stale: only the interval below asks.
        initialData: NOT_ASKED,
        staleTime: Infinity,
        retry: false,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchIntervalInBackground: true,
        refetchInterval: ({ state }) => {
            if (state.fetchStatus === 'fetching' || !state.data || state.data.items.length > 0) return false;
            return REMEMBERED_POLL_DELAYS_MS[state.data.asks] ?? false;
        },
    });
    return { found: data.items, done: data.items.length > 0 || (!isFetching && data.asks >= REMEMBERED_POLL_DELAYS_MS.length) };
}
