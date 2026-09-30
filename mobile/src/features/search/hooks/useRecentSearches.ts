/**
 * Recent searches: the terms, and the three ways they change. Each write goes
 * to the device store and then straight into the query cache, so the list on
 * screen is the list on disk without a refetch.
 */

import { useQueryClient } from '@tanstack/react-query';

import { useRecentSearchTerms } from './queries';
import { searchKeys } from '../api/keys';
import { MIN_QUERY_LENGTH } from '../api/matches';
import { clearRecentSearches, pushRecentSearch, removeRecentSearch } from '../model/recent';

export function useRecentSearches() {
    const queryClient = useQueryClient();
    const recent = useRecentSearchTerms();
    const store = (next: string[]) => queryClient.setQueryData(searchKeys.recent, next);

    return {
        terms: recent.data ?? [],
        remember: (value: string) => {
            const trimmed = value.trim();
            if (trimmed.length < MIN_QUERY_LENGTH) return;
            void pushRecentSearch(trimmed).then(store);
        },
        remove: (value: string) => void removeRecentSearch(value).then(store),
        clear: () => void clearRecentSearches().then(() => store([])),
    };
}
