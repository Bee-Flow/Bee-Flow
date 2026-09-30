/**
 * The detail-screen scaffold: a Screen with its header, then a spinner, an
 * error, or a pull-to-refresh ScrollView rendering `children(data)`. Data that
 * is loaded stays when a later refetch fails, under a StaleNote; the error
 * state is for a screen with nothing to show.
 *
 * Detail screens wrote the same three early returns by hand, each repeating the
 * Screen and header. Here the header is rendered once for every state, so the
 * back button is there while the data loads and when it fails.
 */

import React, { type ReactNode } from 'react';
import { RefreshControl, ScrollView, type StyleProp, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ErrorState, LoadingState, Screen, type ScreenProps } from '@/shared/ui';

import { isStale, StaleNote } from './StaleNote';
import { useUserRefresh } from './useUserRefresh';

/** The slice of a React Query result the screen reads. `useQuery()` fits as-is. */
export interface DetailQuery<T> {
    data: T | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    /** Retry and pull-to-refresh. Return the promise: the pull spins until it settles. */
    refetch: () => unknown;
}

export interface QueryScreenProps<T> {
    query: DetailQuery<T>;
    /** The body, once there is data. */
    children: (data: T) => ReactNode;
    /** Rendered above every state; receives the data once it has arrived. */
    header?: (data: T | undefined) => ReactNode;
    /** Caption under the loading spinner. */
    loadingLabel?: string;
    /**
     * What a pull runs, when it should do more than refetch `query` — a screen
     * made of several queries returns `Promise.all` of their refetches. The
     * spinner shows from the pull until that promise settles, never for a
     * background refetch (see useUserRefresh).
     */
    refresh?: () => unknown;
    /** Set false when the body brings its own scroll container. */
    scroll?: boolean;
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** Passed to the Screen frame (edges default to top and bottom). */
    screen?: Omit<ScreenProps, 'children'>;
}

const makeStyles = (theme: Theme) => ({
    content: {
        paddingHorizontal: theme.spacing.lg,
        paddingBottom: theme.spacing.xxxl,
        gap: theme.spacing.xl,
    },
});

export function QueryScreen<T>({
    query,
    children,
    header,
    loadingLabel,
    refresh,
    scroll = true,
    contentContainerStyle,
    screen,
}: QueryScreenProps<T>) {
    const theme = useTheme();
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const data = query.data ?? undefined;
    const pull = useUserRefresh(refresh ?? (() => query.refetch()));

    let body: ReactNode;
    if (query.isLoading && data === undefined) {
        body = <LoadingState label={loadingLabel} />;
    } else if (data === undefined) {
        const error =
            query.error ?? new Error(t('mobile.patterns.not_loaded', 'This could not be loaded.'));
        body = <ErrorState error={error} onRetry={() => void query.refetch()} />;
    } else if (!scroll) {
        body = children(data);
    } else {
        body = (
            <ScrollView
                testID="query-screen-scroll"
                // A body can hold a field (a playbook's hand-off brief, above
                // its Continue button). With the default ('never') the first
                // tap on a button while the keyboard is up only closes the
                // keyboard, and the button never hears it.
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={contentContainerStyle ?? styles.content}
                refreshControl={
                    <RefreshControl
                        refreshing={pull.refreshing}
                        onRefresh={pull.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {children(data)}
            </ScrollView>
        );
    }

    return (
        <Screen edges={['top', 'bottom']} {...screen}>
            {header?.(data)}
            {isStale(query) ? <StaleNote error={query.error} onRetry={() => void query.refetch()} /> : null}
            {body}
        </Screen>
    );
}
