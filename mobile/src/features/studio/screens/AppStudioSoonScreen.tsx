/**
 * App Studio on the phone: not yet. Building and editing apps waits for a
 * later release, so the Studio section, its New entry and the web's
 * `/app/studio/apps[/<id>]` links land here. Running an app is not affected:
 * the apps directory and `/apps/<id>` open as before, and so does this
 * screen's button. The ported App Studio core (features/app-studio) is the
 * foundation the builder will stand on; nothing renders it yet.
 */

import { router } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { openRoute } from '@/shared/navigation';
import { EmptyState, Screen, ScreenHeader } from '@/shared/ui';

export function AppStudioSoonScreen({ appId }: { appId?: string }) {
    const t = useTranslation();
    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={t('mobile.studio.app_studio', 'App Studio')} />
            <EmptyState
                icon="LayoutGrid"
                title={t('mobile.studio.app_studio_soon_title', 'App Studio is coming soon')}
                message={t(
                    'mobile.studio.app_studio_soon_message',
                    'Building and editing apps on the phone is on its way. Until then, build them in Bee Flow on the web; the apps your organisation publishes already open here.',
                )}
                actionLabel={
                    appId
                        ? t('mobile.studio.app_studio_open_app', 'Open this app')
                        : t('mobile.studio.app_studio_open_apps', 'Open your apps')
                }
                actionIcon="AppWindow"
                onAction={() => openRoute(router, appId ? `/apps/${encodeURIComponent(appId)}?draft=1` : '/apps')}
            />
        </Screen>
    );
}
