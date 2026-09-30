/**
 * Search everything.
 *
 * Reached from the header of every tab, so it opens with the keyboard already
 * up — the screen exists for one purpose and asking for a second tap to start
 * typing is a tax on the most-used affordance in the app. The keyboard NEVER
 * closes on its own either: a result can be tapped straight through, and
 * scrolling does not dismiss it (ResultList, RecentSearches).
 */

import { Stack, useRouter } from 'expo-router';
import React from 'react';

import { openRoute } from '@/shared/navigation';
import { EmptyState, ErrorState, ListSkeleton, Screen } from '@/shared/ui';

import { RecentSearches } from '../components/RecentSearches';
import { ResultCount } from '../components/ResultCount';
import { ResultList } from '../components/ResultList';
import { SearchBar } from '../components/SearchBar';
import { useRecentSearches } from '../hooks/useRecentSearches';
import { useSearch } from '../hooks/useSearch';
import type { SearchHit } from '../model/types';

export function SearchScreen() {
    const router = useRouter();
    const search = useSearch();
    const recent = useRecentSearches();

    const openHit = (hit: SearchHit) => {
        if (!hit.href) return;
        recent.remember(search.debounced);
        openRoute(router, hit.href);
    };

    let body: React.ReactElement;
    if (!search.active) {
        body = (
            <RecentSearches
                terms={recent.terms}
                onPick={search.pick}
                onRemove={recent.remove}
                onClear={recent.clear}
                tooShort={search.term.trim().length > 0}
            />
        );
    } else if (search.firstLoad) {
        body = <ListSkeleton rows={5} />;
    } else if (search.everythingFailed) {
        body = <ErrorState error={search.sections[0]?.error} onRetry={search.refresh} />;
    } else if (search.total === 0 && !search.searching) {
        body = (
            <EmptyState
                icon="Search"
                title={`Nothing matched “${search.debounced}”`}
                message="Try a shorter phrase, or a word you know appears in the text."
                actionLabel="Start a chat about it"
                onAction={() => router.push('/chat/new')}
            />
        );
    } else {
        body = (
            <ResultList
                sections={search.sections}
                refreshing={search.refreshing}
                onRefresh={search.refresh}
                onOpen={openHit}
            />
        );
    }

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />
            <SearchBar
                value={search.term}
                onChange={search.setTerm}
                onSubmit={() => recent.remember(search.term)}
                onBack={() => router.back()}
                searching={search.searching}
            />
            {search.active ? <ResultCount total={search.total} searching={search.searching} /> : null}
            {body}
        </Screen>
    );
}
