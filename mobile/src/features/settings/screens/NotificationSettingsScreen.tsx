/**
 * Notification settings, on this phone.
 *
 * Bee Flow does NOT use Google's push service (NoPushBanner says why that is
 * the point), so everything here is a per-device preference: the server has
 * no notification-preference table — `notifications` is a log with a
 * `category` column and nothing that records who wants what. The screen says
 * which settings are per-device so nobody expects them on the web. The
 * notification list itself opens from the bell in the header.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { GroupedScroll, LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { NoPushBanner } from '../components/NoPushBanner';
import { NotificationPrefsGroups } from '../components/NotificationPrefsGroups';
import { OsPermissionGroup } from '../components/OsPermissionGroup';
import { useNotificationSettings } from '../hooks/useNotificationSettings';

export function NotificationSettingsScreen() {
    const t = useTranslation();
    const { prefs, permission, blocked, update, setCategory, requestPermission } = useNotificationSettings();
    const title = t('settings.notifications', 'Notifications');

    if (!prefs) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title={title} />
                <LoadingState />
            </Screen>
        );
    }

    const osBlocked = !permission.unknown && !permission.granted;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={title} subtitle={t('mobile.notifications.on_this_phone', 'On this phone')} />

            <GroupedScroll>
                <NoPushBanner />
                {osBlocked ? (
                    <OsPermissionGroup denied={blocked} onRequest={() => void requestPermission()} />
                ) : null}
                <NotificationPrefsGroups prefs={prefs} onChange={update} onCategory={setCategory} />
            </GroupedScroll>
        </Screen>
    );
}
