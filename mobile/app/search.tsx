/**
 * Search everything.
 *
 * Reached from the header of every tab, so it opens with the keyboard already
 * up — the screen exists for one purpose and asking for a second tap to start
 * typing is a tax on the most-used affordance in the app.
 *
 * Two things this screen is careful about:
 *
 *   1. The keyboard NEVER closes on its own. `keyboardShouldPersistTaps` lets a
 *      result be tapped straight through, and `keyboardDismissMode="none"`
 *      means scrolling the results does not dismiss it either. Refining a query
 *      after glancing at the answers is the normal path, and a keyboard that
 *      vanishes on the first scroll makes that a three-tap operation.
 *   2. Results appear in two waves. The three surfaces with a real search
 *      endpoint (chats, notebooks, knowledge-base passages) are re-queried on
 *      each debounce; the three whose list routes take no query are fetched
 *      once and filtered on the device, so they answer instantly from cache
 *      while the network catches up. src/features/search/api.ts explains why
 *      that split exists, and each group says which kind it is.
 */

import { Feather } from '@expo/vector-icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, SectionList, View } from 'react-native';

import { useAuth } from '../src/auth/AuthProvider';
import {
    buildResults,
    EMPTY_CORPUS,
    EMPTY_MATCHES,
    fetchSearchCorpus,
    fetchServerMatches,
    MIN_QUERY_LENGTH,
    searchKeys,
} from '../src/features/search/api';
import {
    clearRecentSearches,
    loadRecentSearches,
    pushRecentSearch,
    removeRecentSearch,
} from '../src/features/search/recent';
import type { SearchGroupKey, SearchHit } from '../src/features/search/types';
import { GROUP_LABELS, GROUP_STRATEGY } from '../src/features/search/types';
import { useTheme } from '../src/theme/ThemeProvider';
import { Badge } from '../src/ui/Badge';
import { IconButton } from '../src/ui/Button';
import { describeError, EmptyState, ErrorState, ListSkeleton, Spinner } from '../src/ui/Feedback';
import { SearchField } from '../src/ui/Input';
import { ListRow } from '../src/ui/List';
import { Screen } from '../src/ui/Screen';
import { Text } from '../src/ui/Text';

/** 250ms: long enough to skip the middle of a word, short enough to feel live. */
const DEBOUNCE_MS = 250;

const GROUP_ICONS: Record<SearchGroupKey, keyof typeof Feather.glyphMap> = {
    places: 'compass',
    chats: 'message-square',
    notebooks: 'book',
    documents: 'file-text',
    knowledge: 'database',
    automations: 'zap',
    transcripts: 'mic',
};

interface Section {
    key: SearchGroupKey;
    title: string;
    /** True when this group was filtered on the phone rather than the server. */
    local: boolean;
    error: unknown;
    data: SearchHit[];
}

export default function SearchScreen() {
    const { user, permissions } = useAuth();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();

    const [term, setTerm] = useState('');
    const [debounced, setDebounced] = useState('');

    useEffect(() => {
        const handle = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [term]);

    const active = debounced.length >= MIN_QUERY_LENGTH;

    /**
     * The three query-less lists. A long staleTime on purpose: this is the
     * corpus every keystroke filters, and refetching it per character would
     * turn a local filter back into a network round-trip.
     */
    const corpusQuery = useQuery({
        queryKey: searchKeys.corpus,
        queryFn: ({ signal }) => fetchSearchCorpus(signal),
        staleTime: 5 * 60_000,
    });

    const matchesQuery = useQuery({
        queryKey: searchKeys.query(debounced),
        queryFn: ({ signal }) => fetchServerMatches(debounced, signal),
        enabled: active,
        // Keep the previous term's answers on screen while the next request is
        // in flight. Blanking the list on every keystroke reads as "no results"
        // for 200ms, which is exactly when someone gives up and retypes.
        placeholderData: keepPreviousData,
    });

    const recentQuery = useQuery({
        queryKey: searchKeys.recent,
        queryFn: () => loadRecentSearches(),
        staleTime: Infinity,
    });

    const results = useMemo(
        () =>
            buildResults(
                debounced,
                corpusQuery.data ?? EMPTY_CORPUS,
                matchesQuery.data ?? EMPTY_MATCHES,
                // Screens the caller may not open must not appear in a result
                // list — a row that 403s is worse than no row.
                { permissions: permissions?.permissions ?? null, isAdmin: Boolean(user?.isAdmin) },
            ),
        [debounced, corpusQuery.data, matchesQuery.data, permissions, user?.isAdmin],
    );

    const sections = useMemo<Section[]>(
        () =>
            results.groups
                // A group with neither hits nor a problem has nothing to say —
                // six "0 results" headings would bury the one that matched.
                .filter((group) => group.hits.length > 0 || group.error)
                .map((group) => ({
                    key: group.key,
                    title: GROUP_LABELS[group.key],
                    local: GROUP_STRATEGY[group.key] === 'corpus',
                    error: group.error,
                    data: group.hits,
                })),
        [results],
    );

    const remember = useCallback(
        (value: string) => {
            const trimmed = value.trim();
            if (trimmed.length < MIN_QUERY_LENGTH) return;
            void pushRecentSearch(trimmed).then((next) =>
                queryClient.setQueryData(searchKeys.recent, next),
            );
        },
        [queryClient],
    );

    const openHit = useCallback(
        (hit: SearchHit) => {
            if (!hit.href) return;
            remember(debounced);
            router.push(hit.href as never);
        },
        [debounced, remember, router],
    );

    const refresh = useCallback(() => {
        void corpusQuery.refetch();
        if (active) void matchesQuery.refetch();
    }, [active, corpusQuery, matchesQuery]);

    // Every leg failed AND nothing came back: that is a screen-level error, not
    // six inline notes. One retry is more useful than six explanations.
    const everythingFailed =
        results.total === 0 &&
        sections.length > 0 &&
        sections.every((section) => Boolean(section.error));

    const searching = active && (matchesQuery.isFetching || corpusQuery.isFetching);
    const firstLoad = active && matchesQuery.isLoading && corpusQuery.isLoading;

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />

            {/*
              * The one screen that does NOT use ScreenHeader, and deliberately.
              * Its header has no title: the input IS the title, focused on
              * arrival, because this screen exists to be typed into. Giving it a
              * heading above the field would push the field down for a word the
              * user already knows.
              */}
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.sm,
                    paddingVertical: theme.spacing.sm,
                }}
            >
                <IconButton
                    icon={<Feather name="arrow-left" size={20} color={theme.colors.textPrimary} />}
                    accessibilityLabel="Back"
                    onPress={() => router.back()}
                />
                <SearchField
                    value={term}
                    onChangeText={setTerm}
                    placeholder="Search chats, notebooks, documents"
                    autoFocus
                    onSubmit={() => remember(term)}
                    style={{ flex: 1 }}
                />
                <View style={{ width: 24, alignItems: 'center' }}>
                    {searching ? <Spinner /> : null}
                </View>
            </View>

            {/* The count is a live region: after typing, the only feedback a
                screen-reader user gets is this line. */}
            {active ? (
                <View
                    accessibilityLiveRegion="polite"
                    style={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.xs,
                    }}
                >
                    <Text variant="label" tone="tertiary">
                        {results.total === 0
                            ? searching
                                ? 'Searching…'
                                : 'No matches'
                            : `${results.total} result${results.total === 1 ? '' : 's'}`}
                    </Text>
                </View>
            ) : null}

            {!active ? (
                <RecentSearches
                    terms={recentQuery.data ?? []}
                    onPick={(value) => {
                        setTerm(value);
                        setDebounced(value);
                    }}
                    onRemove={(value) => {
                        void removeRecentSearch(value).then((next) =>
                            queryClient.setQueryData(searchKeys.recent, next),
                        );
                    }}
                    onClear={() => {
                        void clearRecentSearches().then(() =>
                            queryClient.setQueryData(searchKeys.recent, []),
                        );
                    }}
                    tooShort={term.trim().length > 0}
                />
            ) : firstLoad ? (
                <ListSkeleton rows={5} />
            ) : everythingFailed ? (
                <ErrorState error={sections[0]?.error} onRetry={refresh} />
            ) : results.total === 0 && !searching ? (
                <EmptyState
                    icon="search"
                    title={`Nothing matched “${debounced}”`}
                    message="Try a shorter phrase, or a word you know appears in the text."
                    actionLabel="Start a chat about it"
                    onAction={() => router.push('/chat/new')}
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(hit) => hit.key}
                    // Both of these are the point of the screen: a result stays
                    // tappable while the keyboard is up, and scrolling the
                    // results does not dismiss it.
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="none"
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                    refreshControl={
                        <RefreshControl
                            refreshing={corpusQuery.isRefetching}
                            onRefresh={refresh}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderSectionHeader={({ section }) => (
                        <GroupHeader section={section as Section} />
                    )}
                    renderItem={({ item }) => <HitRow hit={item} onPress={openHit} />}
                />
            )}
        </Screen>
    );
}

function GroupHeader({ section }: { section: Section }) {
    const theme = useTheme();
    const problem = section.error ? describeError(section.error) : null;

    return (
        <View
            style={{
                paddingHorizontal: theme.spacing.lg,
                paddingTop: theme.spacing.lg,
                paddingBottom: theme.spacing.xs,
                gap: theme.spacing.xxs,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Feather
                    name={GROUP_ICONS[section.key]}
                    size={14}
                    color={theme.colors.textMuted}
                />
                <Text variant="label" tone="tertiary" accessibilityRole="header">
                    {section.title.toUpperCase()}
                </Text>
                {/* Say so when a group could only match what the list route
                    already sent — otherwise "why didn't it find that word"
                    has no answer. */}
                {section.local && section.data.length > 0 ? (
                    <Text variant="label" tone="tertiary">
                        · searched on this device
                    </Text>
                ) : null}
            </View>
            {problem ? (
                <Text variant="caption" tone="warning">
                    {problem.title}. {problem.message}
                </Text>
            ) : null}
        </View>
    );
}

function HitRow({ hit, onPress }: { hit: SearchHit; onPress: (hit: SearchHit) => void }) {
    // No href means this app has no screen for the thing. The row still shows —
    // knowing it exists is most of the value — but it is not a button, because
    // a tap that does nothing is worse than no tap at all.
    return (
        <ListRow
            title={hit.title}
            subtitle={hit.subtitle || undefined}
            meta={hit.meta}
            wrapTitle
            onPress={hit.href ? () => onPress(hit) : undefined}
            trailing={hit.href ? undefined : <Badge label="Web only" tone="neutral" />}
        />
    );
}

function RecentSearches({
    terms,
    onPick,
    onRemove,
    onClear,
    tooShort,
}: {
    terms: string[];
    onPick: (term: string) => void;
    onRemove: (term: string) => void;
    onClear: () => void;
    tooShort: boolean;
}) {
    const theme = useTheme();

    if (terms.length === 0) {
        return (
            <EmptyState
                icon="search"
                title={tooShort ? 'Keep typing' : 'Search everything'}
                message={
                    tooShort
                        ? `Two characters or more, and Bee Flow starts looking.`
                        : 'Chats, notebooks, documents, knowledge bases, routines and meeting notes — all at once.'
                }
            />
        );
    }

    return (
        <FlatList
            data={terms}
            keyExtractor={(value) => value}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            ListHeaderComponent={
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: theme.spacing.lg,
                        paddingTop: theme.spacing.lg,
                    }}
                >
                    <Text variant="label" tone="tertiary" accessibilityRole="header" style={{ flex: 1 }}>
                        RECENT SEARCHES
                    </Text>
                    <IconButton
                        icon={<Feather name="trash-2" size={16} color={theme.colors.textMuted} />}
                        accessibilityLabel="Clear all recent searches"
                        onPress={onClear}
                    />
                </View>
            }
            renderItem={({ item }) => (
                <ListRow
                    title={item}
                    leading={<Feather name="clock" size={16} color={theme.colors.textMuted} />}
                    onPress={() => onPick(item)}
                    trailing={
                        <IconButton
                            icon={<Feather name="x" size={16} color={theme.colors.textMuted} />}
                            accessibilityLabel={`Forget the search ${item}`}
                            onPress={() => onRemove(item)}
                        />
                    }
                />
            )}
            ListFooterComponent={
                <Text
                    variant="caption"
                    tone="tertiary"
                    style={{ padding: theme.spacing.lg }}
                >
                    Recent searches are kept on this phone only — they are never sent to your
                    server.
                </Text>
            }
        />
    );
}
