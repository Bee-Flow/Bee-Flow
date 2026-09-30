/**
 * What a tab's list shows when it has no rows: a spinner while it loads, the
 * error with Retry when it failed, and otherwise the empty state it was given.
 * Used as the list's ListEmptyComponent, so the header stays in place.
 */

import React from 'react';

import { EmptyState, ErrorState, LoadingState, type IconName } from '@/shared/ui';

export interface ListFallbackProps {
    query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
    icon: IconName;
    title: string;
    message?: string;
}

export function ListFallback({ query, icon, title, message }: ListFallbackProps) {
    if (query.isLoading) return <LoadingState />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    return <EmptyState icon={icon} title={title} message={message} />;
}
