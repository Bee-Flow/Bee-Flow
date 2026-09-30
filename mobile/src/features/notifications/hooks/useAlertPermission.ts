/**
 * Android's notification permission, for a place that explains why it is
 * wanted (Settings → Notifications, the empty inbox). Nothing else asks: the
 * poll is registered at sign-in without it (background.ts).
 *
 * - It is read on mount and again whenever the app comes back to the front,
 *   so a person returning from Android's settings sees what they chose there.
 * - `allow()` shows the system dialog while Android will still show it, and
 *   opens this app's page in Android's settings only once it will not (two
 *   refusals, or notifications switched off there). A first refusal is not a
 *   reason to throw the person into the settings app.
 * - A grant starts the announcing (startAnnouncing): the backlog stays quiet,
 *   and polling is registered if the OS had refused it before.
 */

import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';

import { deniedForGood, openAppSettings, useOnForeground } from '@/shared/device/appSettings';

import { registerNotificationPolling, startAnnouncing } from '../background';
import { alertPermissionOf, UNKNOWN_ALERT_PERMISSION, type AlertPermission } from '../model/permission';

/** What a failed read or request counts as: not granted, still worth offering. */
const UNREADABLE: AlertPermission = { granted: false, canAskAgain: true, unknown: false };

async function readPermission(): Promise<AlertPermission> {
    try {
        return alertPermissionOf(await Notifications.getPermissionsAsync());
    } catch {
        return UNREADABLE;
    }
}

async function requestPermission(): Promise<AlertPermission> {
    try {
        return alertPermissionOf(await Notifications.requestPermissionsAsync());
    } catch {
        return readPermission();
    }
}

export interface AllowOutcome {
    permission: AlertPermission;
    /** Granted: whether the OS runs the background poll too. Not granted: null. */
    polling: boolean | null;
}

export interface AlertPermissionState {
    permission: AlertPermission;
    /** Refused for good: the button that fixes it opens Android's settings. */
    blocked: boolean;
    refresh: () => Promise<AlertPermission>;
    /** The dialog, or the settings page once Android will not show it. Only call after explaining why. */
    allow: () => Promise<AllowOutcome>;
}

export function useAlertPermission(): AlertPermissionState {
    const [permission, setPermission] = useState<AlertPermission>(UNKNOWN_ALERT_PERMISSION);

    const refresh = useCallback(async () => {
        const next = await readPermission();
        setPermission(next);
        return next;
    }, []);

    useEffect(() => {
        void readPermission().then(setPermission);
    }, []);
    const reread = useCallback(() => void refresh(), [refresh]);
    useOnForeground(reread);

    const allow = useCallback(async (): Promise<AllowOutcome> => {
        const current = await refresh();
        if (current.granted) return { permission: current, polling: await registerNotificationPolling().catch(() => false) };
        let next: AlertPermission;
        if (deniedForGood(current)) {
            await openAppSettings();
            next = await refresh();
        } else {
            next = await requestPermission();
            setPermission(next);
        }
        const polling = next.granted ? await startAnnouncing().catch(() => false) : null;
        return { permission: next, polling };
    }, [refresh]);

    return { permission, blocked: !permission.unknown && deniedForGood(permission), refresh, allow };
}
