/**
 * The search screen's state: the typed term, its debounced twin, both fetches
 * and the merged result groups.
 *
 * Results appear in two waves. The server-searched groups are re-queried on
 * each debounce; the corpus groups answer at once from cache while the
 * network catches up (see api/corpus.ts for why that split exists).
 */

import { useEffect, useMemo, useState } from 'react';

import { useAccess } from '@/core/access';
import { useUserRefresh } from '@/shared/patterns';

import { useSearchCorpus, useServerMatches } from './queries';
import { MIN_QUERY_LENGTH } from '../api/matches';
import { buildResults, EMPTY_CORPUS, EMPTY_MATCHES } from '../model/results';
import { GROUP_LABELS, GROUP_STRATEGY, type SearchGroupKey, type SearchHit } from '../model/types';

/** 250ms: long enough to skip the middle of a word, short enough to feel live. */
const DEBOUNCE_MS = 250;

export interface ResultSection {
    key: SearchGroupKey;
    title: string;
    /** True when this group was filtered on the phone rather than the server. */
    local: boolean;
    error: unknown;
    data: SearchHit[];
}

export function useSearch() {
    const access = useAccess();
    const [term, setTerm] = useState('');
    const [debounced, setDebounced] = useState('');

    useEffect(() => {
        const handle = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [term]);

    const active = debounced.length >= MIN_QUERY_LENGTH;
    const corpus = useSearchCorpus();
    const matches = useServerMatches(debounced, active);

    const results = useMemo(
        () =>
            buildResults(debounced, corpus.data ?? EMPTY_CORPUS, matches.data ?? EMPTY_MATCHES, access),
        [debounced, corpus.data, matches.data, access],
    );

    // A group with neither hits nor a problem has nothing to say — six
    // "0 results" headings would bury the one that matched.
    const sections: ResultSection[] = results.groups
        .filter((group) => group.hits.length > 0 || group.error)
        .map((group) => ({
            key: group.key,
            title: GROUP_LABELS[group.key],
            local: GROUP_STRATEGY[group.key] === 'corpus',
            error: group.error,
            data: group.hits,
        }));

    const searching = active && (matches.isFetching || corpus.isFetching);
    const pull = useUserRefresh(() => Promise.all([corpus.refetch(), active ? matches.refetch() : undefined]));
    return {
        term,
        setTerm,
        debounced,
        /** A recent term: searched at once, without waiting out the debounce. */
        pick: (value: string) => {
            setTerm(value);
            setDebounced(value);
        },
        active,
        total: results.total,
        sections,
        searching,
        firstLoad: active && matches.isLoading && corpus.isLoading,
        // Every leg failed AND nothing came back: one screen-level error with
        // one retry is more useful than six explanations.
        everythingFailed: results.total === 0 && sections.length > 0 && sections.every((s) => Boolean(s.error)),
        refreshing: pull.refreshing,
        refresh: pull.onRefresh,
    };
}
