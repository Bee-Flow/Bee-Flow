/**
 * The microphone permission, read without prompting or asked for — the one
 * hook the voice call and the recorder share.
 *
 * Asking is a separate call on purpose: neither flow starts with a system
 * dialog, because asking cold burns the one prompt Android gives you. And a
 * failure to READ the permission is not a denial: it reads as "unknown but
 * askable", so the person still gets a path forward.
 */

import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { useCallback, useState } from 'react';

import { deniedForGood } from './appSettings';

export interface MicPermission {
    granted: boolean;
    /** False once Android's "don't ask again" has been spent. */
    canAskAgain: boolean;
    /** True until the first check resolves, so the UI can wait rather than lie. */
    unknown: boolean;
}

/** `onRequestError` hears a system dialog that failed outright. */
export function useMicPermission(onRequestError: (err: unknown) => void) {
    const [permission, setPermission] = useState<MicPermission>({
        granted: false,
        canAskAgain: true,
        unknown: true,
    });

    const refreshPermission = useCallback(async (): Promise<MicPermission> => {
        let next: MicPermission;
        try {
            const res = await getRecordingPermissionsAsync();
            next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
        } catch {
            next = { granted: false, canAskAgain: true, unknown: false };
        }
        setPermission(next);
        return next;
    }, []);

    /** Shows the system dialog. Only call after explaining why. */
    const requestPermission = useCallback(async (): Promise<MicPermission> => {
        let next: MicPermission;
        try {
            const res = await requestRecordingPermissionsAsync();
            next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
        } catch (err) {
            onRequestError(err);
            next = { granted: false, canAskAgain: false, unknown: false };
        }
        setPermission(next);
        return next;
    }, [onRequestError]);

    return { permission, refreshPermission, requestPermission };
}

/** Denied for good: Android will not show its dialog again, so only the app's settings can turn it back on. */
export function micBlocked(permission: MicPermission): boolean {
    return !permission.unknown && deniedForGood(permission);
}
