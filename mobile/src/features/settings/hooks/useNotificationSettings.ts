/**
 * This device's notification preferences and Android's permission.
 *
 * The preferences live on the device (features/notifications/model/prefs.ts),
 * because the server has no notification-preference table. Writes are
 * optimistic: the switch moves now and the AsyncStorage write follows — a
 * failed write is not worth a spinner on a toggle.
 *
 * The permission is the notifications feature's useAlertPermission: read
 * again whenever the app comes back to the front (so a person returning from
 * Android's settings sees what they chose), the system dialog while Android
 * still shows it, and Android's settings only once it will not.
 */

import { useCallback, useEffect, useState } from 'react';

import {
    DEFAULT_NOTIFICATION_PREFS,
    loadNotificationPrefs,
    saveNotificationPrefs,
    useAlertPermission,
    type NotificationCategory,
    type NotificationPrefs,
} from '@/features/notifications';

export function useNotificationSettings() {
    const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
    const alerts = useAlertPermission();

    useEffect(() => {
        void loadNotificationPrefs().then(setPrefs);
    }, []);

    const update = useCallback((patch: Partial<NotificationPrefs>) => {
        setPrefs((previous) => {
            const next = { ...(previous ?? DEFAULT_NOTIFICATION_PREFS), ...patch };
            void saveNotificationPrefs(next);
            return next;
        });
    }, []);

    const setCategory = (category: NotificationCategory, value: boolean) => {
        setPrefs((previous) => {
            const base = previous ?? DEFAULT_NOTIFICATION_PREFS;
            const next = { ...base, categories: { ...base.categories, [category]: value } };
            void saveNotificationPrefs(next);
            return next;
        });
    };

    return {
        prefs,
        permission: alerts.permission,
        /** Only Android's settings can turn notifications on now. */
        blocked: alerts.blocked,
        update,
        setCategory,
        requestPermission: alerts.allow,
    };
}
