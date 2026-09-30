/**
 * Background notification polling, and what happens when one is tapped.
 *
 * Mounted once at the root (app/_layout.tsx), inside AuthProvider. Registration
 * is tied to being signed in rather than to opening the inbox: a user who never
 * visits that screen should still be told when something happens. See
 * ../README.md for why this app polls instead of using Firebase.
 *
 * Registering does not ask for Android's notification permission: a dialog
 * right after sign-in, with nothing on screen saying why, is the one people
 * refuse, and it came back on every launch after a refusal. The permission is
 * asked where the reason is shown (hooks/useAlertPermission).
 *
 * Importing this module also imports ../background, whose module body defines
 * the WorkManager task — the guarantee that it is defined at launch rests on
 * that import, not on expo-router happening to require the inbox route.
 */

import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTheme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';

import { registerNotificationPolling } from '../background';
import { claimPushResponse } from '../model/coldStart';

/**
 * @param fontsLoaded the root's font state: cold-start routing waits for the
 *   same readiness AuthGate does before it mounts the navigator.
 */
export function NotificationPlumbing({ fontsLoaded }: { fontsLoaded: boolean }): null {
    const { stage } = useAuth();
    const theme = useTheme();
    const router = useRouter();

    useEffect(() => {
        if (stage.kind !== 'signed-in') return;
        void registerNotificationPolling();
    }, [stage.kind]);

    // Warm taps: the listener hears the response as it happens. The payload's
    // `link` is the server's WEB path (`/app/...`), so it is translated before
    // it reaches the router; the claim helper answers a real screen (or the
    // inbox), and null for a response the cold-start path already routed.
    useEffect(() => {
        const sub = Notifications.addNotificationResponseReceivedListener((response) => {
            const route = claimPushResponse(response);
            if (route) openRoute(router, route);
        });
        return () => sub.remove();
    }, [router]);

    // Cold-start taps: a tap that LAUNCHES the app delivers its response before
    // the listener above exists, so it is fetched back. It waits for AuthGate's
    // own readiness (fonts + theme + signed-in): pushing earlier would address a
    // navigator that is not mounted, and once ready AuthGate's synchronous
    // replace() runs first, so this push lands ON TOP of the home screen and
    // back unwinds somewhere sensible. The claim ledger makes the re-fire after
    // a lapsed session's sign-in safe.
    const coldStartReady = fontsLoaded && theme.hydrated && stage.kind === 'signed-in';
    useEffect(() => {
        if (!coldStartReady) return;
        let cancelled = false;
        Notifications.getLastNotificationResponseAsync()
            .then((response) => {
                if (cancelled || !response) return;
                const route = claimPushResponse(response);
                if (route) openRoute(router, route);
            })
            .catch(() => {
                /* a lost tap beats a crash during launch */
            });
        return () => {
            cancelled = true;
        };
    }, [coldStartReady, router]);

    return null;
}
