/**
 * The note over data that is still on screen after its latest refetch failed.
 *
 * React Query keeps a query's data when a background refetch (a focus, a
 * poll, a pull) fails, and the app runs queries while offline
 * (core/providers/queryClient.ts), so on a phone this is the common way a
 * loaded screen meets an error. What was loaded stays readable; this small
 * banner says it is not fresh and offers the retry. The full ErrorState is for
 * a screen with nothing to show.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button } from '@/shared/ui';

export interface StaleNoteProps {
    /** What the refetch threw; a retry is offered only when repeating it could help. */
    error: unknown;
    onRetry: () => void;
    /** Drop the gutter when the parent already pads (a GroupedScroll). */
    bare?: boolean;
}

/** Loaded data under a failed refetch: keep the data, add the note. */
export function isStale(query: { isError: boolean; data: unknown }): boolean {
    return query.isError && query.data !== undefined && query.data !== null;
}

export function StaleNote({ error, onRetry, bare = false }: StaleNoteProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const retry = describeError(error).retryable ? (
        <Button label={t('mobile.error.retry', 'Try again')} size="sm" variant="ghost" onPress={onRetry} />
    ) : undefined;
    return (
        <View style={bare ? undefined : styles.gutter}>
            <Banner tone="warning" action={retry}>
                {t('mobile.patterns.stale_data', 'Could not refresh — showing what was loaded before.')}
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    gutter: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } satisfies ViewStyle,
});
