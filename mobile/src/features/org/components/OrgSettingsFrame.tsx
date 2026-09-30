/**
 * The frame every org-admin settings section shares: the header, a notice for
 * anyone who is not an administrator of an organisation (the server would
 * answer 403 anyway), the load and error states, the grouped body with
 * pull-to-refresh, and an optional footer — the SaveBar of a form that saves
 * as a whole. A section whose body is a list (Academy) sets `list`: the frame
 * keeps the gate, the load and the error, and the list scrolls itself.
 *
 * A section with a SaveBar passes its `dirty`: leaving with unsaved changes
 * (Back, a swipe) then asks first, through the app's confirm sheet.
 */

import React, { type ReactNode } from 'react';

import { useTranslation } from '@/core/i18n';
import { isStale, StaleNote, useConfirmLeave, useUserRefresh } from '@/shared/patterns';
import { ErrorState, GroupedScroll, LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { OrgLockedNotice, type OrgDenied } from './OrgLockedScreen';

/** The slice of a query result the frame reads; `useQuery()` fits as-is. */
export interface FrameQuery<T> {
    data: T | null | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
}

export interface OrgSettingsFrameProps<T> {
    title: string;
    subtitle?: string;
    /** An org admin with an organisation. */
    allowed: boolean;
    /** Replaces the default "administrators only" notice, e.g. for a licence lock. */
    denied?: OrgDenied;
    /** The gate has not answered yet (entitlements loading): a spinner, neither body nor notice. */
    pending?: boolean;
    /** The body is its own virtualised list with its own refresh; no grouped scroll around it. */
    list?: boolean;
    query: FrameQuery<T>;
    /** Further queries the pull-to-refresh also refetches; return their promise to hold the spinner. */
    onRefresh?: () => unknown;
    children: (data: T) => ReactNode;
    footer?: ReactNode;
    /** The SaveBar's form differs from the server's copy: leaving asks first. Omitted: nothing to lose. */
    dirty?: boolean;
}

/** Its own component, so a frame without a form (billing) never reads the navigation. */
function LeaveGuard({ dirty }: { dirty: boolean }): null {
    useConfirmLeave(dirty);
    return null;
}

function FrameBody<T>({ query, onRefresh, list, children }: Pick<OrgSettingsFrameProps<T>, 'query' | 'onRefresh' | 'list' | 'children'>) {
    const t = useTranslation();
    // Spins for the person's pull only, not for a background refetch.
    const refresh = useUserRefresh(() => Promise.all([query.refetch(), onRefresh?.()]));
    const data = query.data ?? undefined;
    if (query.isLoading && data === undefined) return <LoadingState />;
    // Only with nothing loaded: a failed refetch keeps the section, under a note.
    if (data === undefined) {
        const error = query.error ?? new Error(t('mobile.patterns.not_loaded', 'This could not be loaded.'));
        return <ErrorState error={error} onRetry={() => void query.refetch()} />;
    }
    const retry = () => void query.refetch();
    const stale = isStale(query);
    if (list) {
        return (
            <>
                {stale ? <StaleNote error={query.error} onRetry={retry} /> : null}
                {children(data)}
            </>
        );
    }
    return (
        <GroupedScroll refresh={refresh} keyboardShouldPersistTaps="handled">
            {stale ? <StaleNote error={query.error} onRetry={retry} bare /> : null}
            {children(data)}
        </GroupedScroll>
    );
}

export function OrgSettingsFrame<T>({
    title,
    subtitle,
    allowed,
    denied,
    pending = false,
    list = false,
    query,
    onRefresh,
    children,
    footer,
    dirty,
}: OrgSettingsFrameProps<T>) {
    let body: ReactNode;
    if (pending) body = <LoadingState />;
    else if (!allowed) body = <OrgLockedNotice denied={denied} />;
    else {
        body = (
            <FrameBody query={query} onRefresh={onRefresh} list={list}>
                {children}
            </FrameBody>
        );
    }
    return (
        <Screen edges={['top', 'bottom']} inset>
            {dirty !== undefined ? <LeaveGuard dirty={dirty && allowed && !pending} /> : null}
            <ScreenHeader title={title} subtitle={subtitle} />
            {body}
            {allowed && !pending ? footer : null}
        </Screen>
    );
}
