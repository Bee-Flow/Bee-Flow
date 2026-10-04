/**
 * An empty inbox. Filtered to unread, the way out is "Show all"; otherwise the
 * useful thing to offer is being told while the app is closed.
 *
 * That takes two things, and each has its own words: Android's notification
 * permission (asked here, because this screen says what it is for; once
 * Android will not ask again the button opens its settings), and the
 * background check, which the OS may refuse on its own (a battery saver,
 * "Restricted" background usage). A refused permission is never reported as
 * the OS refusing background work.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, useToast } from '@/shared/ui';

import { registerNotificationPolling } from '../background';
import { useAlertPermission } from '../hooks/useAlertPermission';

export function NotificationsEmpty({ unreadOnly, onShowAll }: { unreadOnly: boolean; onShowAll: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const alerts = useAlertPermission();

    if (unreadOnly) {
        return (
            <EmptyState
                icon="Bell"
                title={t('mobile.notifications.empty_unread_title', 'Nothing unread')}
                message={t('mobile.notifications.empty_unread_body', 'Everything here has been read.')}
                actionLabel={t('mobile.notifications.empty_show_all', 'Show all')}
                onAction={onShowAll}
            />
        );
    }

    /** Null: the permission was not given, and the button already says what is missing. */
    const sayPolling = (polling: boolean | null) => {
        if (polling === null) return;
        if (polling) toast(t('mobile.notifications.polling_on', 'Bee Flow will check for updates in the background'), 'success');
        else toast(t('mobile.notifications.polling_restricted', 'Android is not allowing background work for Bee Flow'), 'error');
    };
    const needsPermission = !alerts.permission.unknown && !alerts.permission.granted;
    const about = t(
        'mobile.notifications.empty_body',
        'Bee Flow tells you here when an automation finishes, an approval is waiting, or a connector needs reconnecting.',
    );

    return (
        <EmptyState
            icon="Bell"
            title={t('mobile.notifications.empty_title', 'No notifications yet')}
            message={
                needsPermission
                    ? `${about} ${t('mobile.notifications.empty_allow_body', 'Allow notifications to hear about it while the app is closed.')}`
                    : about
            }
            actionLabel={
                !needsPermission
                    ? t('mobile.notifications.empty_background', 'Turn on background alerts')
                    : alerts.blocked
                      ? t('mobile.notifications.open_android', 'Open Android settings')
                      : t('mobile.notifications.allow', 'Allow notifications')
            }
            onAction={() => {
                if (needsPermission) void alerts.allow().then((outcome) => sayPolling(outcome.polling));
                else void registerNotificationPolling().then(sayPolling);
            }}
        />
    );
}
