/** Search queries. Screens call these rather than useQuery. */

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { fetchSearchCorpus } from '../api/corpus';
import { searchKeys } from '../api/keys';
import { fetchServerMatches } from '../api/matches';
import { loadRecentSearches } from '../model/recent';

/**
 * The three query-less lists. A long staleTime on purpose: this is the corpus
 * every keystroke filters, and refetching it per character would turn a local
 * filter back into a network round-trip.
 */
export function useSearchCorpus() {
    return useQuery({
        queryKey: searchKeys.corpus,
        queryFn: ({ signal }) => fetchSearchCorpus(signal),
        staleTime: 5 * 60_000,
    });
}

export function useServerMatches(term: string, enabled: boolean) {
    return useQuery({
        queryKey: searchKeys.query(term),
        queryFn: ({ signal }) => fetchServerMatches(term, signal),
        enabled,
        // Keep the previous term's answers on screen while the next request is
        // in flight. Blanking the list on every keystroke reads as "no results"
        // for 200ms, which is exactly when someone gives up and retypes.
        placeholderData: keepPreviousData,
    });
}

/** Kept on the device only; read once, then updated in place by useRecentSearches. */
export function useRecentSearchTerms() {
    return useQuery({
        queryKey: searchKeys.recent,
        queryFn: () => loadRecentSearches(),
        staleTime: Infinity,
    });
}
