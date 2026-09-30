/**
 * The Studio search screen's state: the typed term, its debounced twin, the
 * query, the grouped hits and the one line of prose (model/search.ts).
 */

import { useEffect, useState } from 'react';

import { useStudioSearch } from './queries';
import { searchGroups, searchLine, type SearchGroup, type SearchLine } from '../model/search';

/** The web overlay's debounce: skip the middle of a word, still feel live. */
const DEBOUNCE_MS = 250;

export interface StudioSearchState {
    term: string;
    setTerm: (term: string) => void;
    groups: SearchGroup[];
    line: SearchLine;
    query: string;
}

export function useStudioSearchState(): StudioSearchState {
    const [term, setTerm] = useState('');
    const [debounced, setDebounced] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [term]);
    const search = useStudioSearch(debounced);
    const result = search.data;
    return {
        term,
        setTerm,
        groups: searchGroups(result),
        line: searchLine({ term: debounced, loading: search.isFetching, failed: search.isError, result }),
        query: debounced,
    };
}
