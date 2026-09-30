/**
 * The way back from a permission Android will no longer ask for.
 *
 * Android shows its permission dialog twice at most: after a second "Don't
 * allow" the request answers "denied" at once, without a dialog, so a button
 * that only asks again does nothing. From then on the one route back is this
 * app's own page in Android's settings (`Linking.openSettings()`), and the
 * app has to read the permission again when the person returns from there,
 * because nothing tells it that they changed it.
 *
 * - `deniedForGood` says when that point is reached.
 * - `openAppSettings` opens the page and resolves once the app is back in
 *   front, so a caller can re-read the permission and carry on.
 * - `useOnForeground` re-runs a read each time the app returns to the front,
 *   for a screen that shows a permission's state while the person may be
 *   changing it elsewhere.
 */

import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';

export interface PermissionAnswer {
    granted: boolean;
    /** False once Android will not show its dialog for this permission again. */
    canAskAgain: boolean;
}

/** Refused, and Android will not ask again: only this app's settings can turn it back on. */
export function deniedForGood(permission: PermissionAnswer): boolean {
    return !permission.granted && !permission.canAskAgain;
}

/**
 * Opens this app's page in Android's settings; resolves when the person is
 * back in the app (or at once, when the page could not be opened).
 */
export function openAppSettings(): Promise<void> {
    return new Promise((resolve) => {
        let away = false;
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') {
                away = true;
                return;
            }
            if (!away) return;
            sub.remove();
            resolve();
        });
        Promise.resolve()
            .then(() => Linking.openSettings())
            .catch(() => {
                sub.remove();
                resolve();
            });
    });
}

/** Calls `onActive` whenever the app comes back to the front. */
export function useOnForeground(onActive: () => void, enabled = true): void {
    useEffect(() => {
        if (!enabled) return undefined;
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') onActive();
        });
        return () => sub.remove();
    }, [onActive, enabled]);
}
