/**
 * An app that could not be opened.
 *
 * A 404 here means "not published, or not for you" — the server never
 * distinguishes the two, and neither does this screen. The generic 404
 * sentence ("This item no longer exists", retry suppressed) would be wrong:
 * the owner very often just unpublished the app while it sat in your list,
 * and republishing brings it straight back. So this case keeps its retry.
 */

import React from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { ErrorState, Screen, ScreenHeader } from '@/shared/ui';

export function AppUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    const t = useTranslation();
    const notFound = error instanceof ApiError && error.status === 404;
    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={t('studio_apps_bi.list.app_fallback', 'App')} />
            <ErrorState
                error={
                    notFound
                        ? new Error(
                              t(
                                  'mobile.apps.unpublished',
                                  'This app is not published, or is not shared with you. If it was just unpublished, try again once it is back.',
                              ),
                          )
                        : (error ?? new Error(t('mobile.apps.unavailable', 'This app is not available to you.')))
                }
                onRetry={onRetry}
            />
        </Screen>
    );
}
