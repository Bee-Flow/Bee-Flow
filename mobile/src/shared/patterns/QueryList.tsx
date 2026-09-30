/**
 * The list-screen scaffold: an optional search field, then exactly one of
 * skeleton, error, empty state or a pull-to-refresh FlatList. Rows that are
 * loaded stay when a later refetch fails, under a StaleNote; the error state
 * is for a list with nothing to show.
 *
 * Some twenty-five screens wrote this by hand (app/projects/index.tsx is the
 * canonical copy), each with its own inline separator and renderItem closure.
 * It takes a React Query result as-is, so a screen passes `useX()` straight in
 * and keeps only its row component.
 */

import React, { useState, type ReactElement } from 'react';
import {
    FlatList,
    RefreshControl,
    View,
    type FlatListProps,
    type ListRenderItem,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    Divider,
    EmptyState,
    ErrorState,
    InsetDivider,
    ListSkeleton,
    SearchField,
    type EmptyStateProps,
} from '@/shared/ui';

import { isStale, StaleNote } from './StaleNote';
import { useUserRefresh } from './useUserRefresh';

/** The slice of a React Query result the list reads. `useQuery()` fits as-is. */
export interface ListQuery<T> {
    data: readonly T[] | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    /** Retry and pull-to-refresh. Return the promise: the pull spins until it settles. */
    refetch: () => unknown;
}

export interface QueryListSearch<T> {
    placeholder: string;
    /** Controlled value. Omit both `value` and `onChange` to let the list keep it. */
    value?: string;
    onChange?: (text: string) => void;
    /**
     * Local filtering: does `item` match the trimmed, lower-cased needle? Omit
     * when the server filters (the search text is in the query key).
     */
    match?: (item: T, needle: string) => boolean;
}

/** The "nothing matches" variant of the empty state, with a clear-search action. */
export interface QueryListNoMatch {
    title: string;
    message?: string;
    /** Label of the button that clears the search. */
    clearLabel?: string;
}

export interface QueryListProps<T> {
    query: ListQuery<T>;
    renderItem: ListRenderItem<T>;
    keyExtractor: (item: T, index: number) => string;
    /** Shown when the query answered with no rows at all. */
    empty: EmptyStateProps;
    /** Shown when rows exist but none survives the search or `filter`. */
    noMatch?: QueryListNoMatch;
    search?: QueryListSearch<T>;
    /** A screen-level filter (a chip row, say), applied before the search. */
    filter?: (item: T) => boolean;
    /** Hairline between rows: inset to the row text (default), full width, or none. */
    separator?: 'inset' | 'full' | 'none';
    skeletonRows?: number;
    ListHeaderComponent?: ReactElement | null;
    ListFooterComponent?: ReactElement | null;
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** Anything else FlatList takes (onEndReached, initialNumToRender, …). */
    listProps?: Omit<
        FlatListProps<T>,
        'data' | 'renderItem' | 'keyExtractor' | 'refreshControl' | 'ItemSeparatorComponent'
    >;
}

// Module-level, not inline: an inline separator is a new component type on
// every render, so FlatList remounts every divider each time.
function FullSeparator() {
    return <Divider />;
}
const SEPARATORS = { inset: InsetDivider, full: FullSeparator, none: undefined } as const;

const makeStyles = (theme: Theme) => ({
    searchBar: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    content: { paddingBottom: theme.spacing.xxl },
});

/** Which rows survive `filter` and the search needle. */
export function visibleRows<T>(
    all: readonly T[],
    needle: string,
    filter?: (item: T) => boolean,
    match?: (item: T, needle: string) => boolean,
): readonly T[] {
    const filtered = filter ? all.filter(filter) : all;
    if (!needle || !match) return filtered;
    return filtered.filter((item) => match(item, needle));
}

/**
 * Is an empty result a miss rather than "none yet"? Locally, only when there
 * was something to filter; with server search, whenever a needle was sent.
 */
function isMiss(total: number, needle: string, localMatch: boolean): boolean {
    return total > 0 || (!localMatch && needle !== '');
}

/** The search text: the caller's when controlled, otherwise the list's own. */
function useSearchText<T>(search: QueryListSearch<T> | undefined): [string, (text: string) => void] {
    const [own, setOwn] = useState('');
    if (search?.onChange) return [search.value ?? '', search.onChange];
    return [search?.value ?? own, setOwn];
}

interface EmptyProps {
    empty: EmptyStateProps;
    noMatch: QueryListNoMatch | undefined;
    miss: boolean;
    /** Present when a search is active and clearing it could help. */
    onClear: (() => void) | undefined;
}

function Empty({ empty, noMatch, miss, onClear }: EmptyProps) {
    if (!miss || !noMatch) return <EmptyState {...empty} />;
    return (
        <EmptyState
            icon={empty.icon}
            title={noMatch.title}
            message={noMatch.message}
            actionLabel={onClear ? noMatch.clearLabel : undefined}
            onAction={onClear}
        />
    );
}

function Rows<T>({ props, rows }: { props: QueryListProps<T>; rows: readonly T[] }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { query } = props;
    // The person's pull only: `query.isRefetching` would spin for every poll.
    const refresh = useUserRefresh(() => query.refetch());
    return (
        <FlatList
            {...props.listProps}
            data={rows}
            keyExtractor={props.keyExtractor}
            renderItem={props.renderItem}
            ItemSeparatorComponent={SEPARATORS[props.separator ?? 'inset']}
            ListHeaderComponent={props.ListHeaderComponent}
            ListFooterComponent={props.ListFooterComponent}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            contentContainerStyle={props.contentContainerStyle ?? styles.content}
        />
    );
}

export function QueryList<T>(props: QueryListProps<T>) {
    const { query, search } = props;
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useSearchText(search);
    const needle = text.trim().toLowerCase();
    const all = query.data ?? [];
    const rows = visibleRows(all, needle, props.filter, search?.match);

    let body: ReactElement;
    if (query.isLoading) {
        body = <ListSkeleton rows={props.skeletonRows} />;
    } else if (query.isError && query.data === undefined) {
        // Only with nothing loaded: a failed refetch keeps its rows (StaleNote).
        body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    } else if (rows.length === 0) {
        const miss = isMiss(all.length, needle, Boolean(search?.match));
        body = (
            <Empty
                empty={props.empty}
                noMatch={props.noMatch}
                miss={miss}
                onClear={needle ? () => setText('') : undefined}
            />
        );
    } else {
        body = <Rows props={props} rows={rows} />;
    }

    return (
        <>
            {search ? (
                <View style={styles.searchBar}>
                    <SearchField value={text} onChangeText={setText} placeholder={search.placeholder} />
                </View>
            ) : null}
            {isStale(query) ? (
                <StaleNote error={query.error} onRetry={() => void query.refetch()} />
            ) : null}
            {body}
        </>
    );
}
