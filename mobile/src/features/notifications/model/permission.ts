/**
 * Android's notification permission, as the app acts on it.
 *
 * expo-notifications answers three things that do not always agree: `status`
 * (granted, denied, undetermined), `granted` (the POST_NOTIFICATIONS grant)
 * and `canAskAgain`. They part ways when the grant stands but the person
 * switched Bee Flow's notifications off in Android's settings: `granted` is
 * true, `status` is denied, and no dialog can change it. Below Android 13
 * there is no dialog at all, and `canAskAgain` is false whenever
 * notifications are off. Both read here as "only Android's settings can turn
 * it on", which is what decides between the system dialog and the settings
 * page.
 */

import type { PermissionAnswer } from '@/shared/device/appSettings';

export interface AlertPermission extends PermissionAnswer {
    /** True until the first read resolves, so the UI can wait rather than guess. */
    unknown: boolean;
}

export const UNKNOWN_ALERT_PERMISSION: AlertPermission = { granted: false, canAskAgain: true, unknown: true };

/** The slice of expo-notifications' answer this reads. */
export interface NotificationPermissionAnswer {
    status: string;
    granted: boolean;
    canAskAgain: boolean;
}

export function alertPermissionOf(answer: NotificationPermissionAnswer): AlertPermission {
    const granted = answer.status === 'granted';
    // A grant with a status that is not granted is notifications switched off
    // in Android's settings, where no dialog reaches.
    const canAskAgain = granted || (answer.canAskAgain && !answer.granted);
    return { granted, canAskAgain, unknown: false };
}
