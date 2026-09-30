/**
 * The headline fact, in one line: Bee Flow does NOT use Google's push
 * service. No Firebase sender id, no FCM token leaves the device; the app
 * polls its own server and raises the notification locally — which is why a
 * notification can be up to one check late, and why "How often to check"
 * exists below.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner } from '@/shared/ui';

export function NoPushBanner() {
    const t = useTranslation();
    return (
        <Banner tone="success" icon="Shield">
            {t('mobile.notifications.no_push', 'Private by design: Bee Flow checks your own server for news, never Google.')}
        </Banner>
    );
}
