/**
 * Root layout: providers, fonts, and the gate that decides whether the user
 * sees the app or one of the eight ways in.
 *
 * The gate lives here rather than in each screen because expo-router mounts
 * routes eagerly — a chat screen that renders before we know who is signed in
 * would fire its queries, take a 401, and bounce the whole stack.
 */

import {
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    useFonts,
} from '@expo-google-fonts/inter';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect } from 'react';
import { AppState, StyleSheet, View, type AppStateStatus } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiError, setConnectivity } from '../src/api/client';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { ErrorBoundary } from '../src/diagnostics/ErrorBoundary';
import { installGlobalErrorHandler } from '../src/diagnostics/report';
// Also imported for its side effect: the module body defines the WorkManager
// task. expo-router happens to require every route file, so notifications.tsx
// would define it too — but the guarantee should not rest on that.
import { registerNotificationPolling } from '../src/features/notifications/background';
import { claimPushResponse } from '../src/features/notifications/coldStart';
import { RecoveryKeyCard } from '../src/features/onboarding/RecoveryKeyCard';
import { ShareIntentGate } from '../src/features/search/ShareIntentGate';
import { BrandingSync } from '../src/features/settings/BrandingSync';
import { LocaleSync } from '../src/i18n/LocaleSync';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { ToastProvider } from '../src/ui/Toast';

// Held until the auth stage is known, so the app never flashes a login screen
// at someone who is already signed in.
void SplashScreen.preventAutoHideAsync();

/**
 * React Query, tuned for a phone rather than a desktop tab.
 *
 * `retry` deliberately does not retry a 4xx: a 402 (plan limit) or 403 (not
 * entitled) is a settled answer, and retrying it three times just delays the
 * message and spends the user's data.
 */
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            retry: (failureCount, error) => {
                if (error instanceof ApiError && error.status && error.status < 500) return false;
                return failureCount < 2;
            },
            // The app is backgrounded constantly; refetching on every return to
            // foreground is what makes it feel live rather than stale.
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
        },
        mutations: { retry: false },
    },
});

// React Query's web defaults for "is the app focused" and "are we online" do
// nothing in React Native — these bridge them to the platform's own signals.
onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected))),
);

// The HTTP client's own view of the network, so a request that fails while
// there is none is reported as being offline rather than as a server fault.
// A captive portal counts as offline: connected, but nothing reachable.
NetInfo.addEventListener((state) =>
    setConnectivity(Boolean(state.isConnected) && state.isInternetReachable !== false),
);

function useAppStateFocus() {
    useEffect(() => {
        const handler = (status: AppStateStatus) => focusManager.setFocused(status === 'active');
        const sub = AppState.addEventListener('change', handler);
        return () => sub.remove();
    }, []);
}

// At module scope, not in an effect: a throw during the first render of the
// tree happens before any effect runs, and that is precisely the crash worth
// catching. Installing it here means the handler is armed the moment the JS
// bundle is evaluated.
installGlobalErrorHandler();

export default function RootLayout() {
    const [fontsLoaded] = useFonts({
        Inter_400Regular,
        Inter_500Medium,
        Inter_600SemiBold,
        Inter_700Bold,
    });
    useAppStateFocus();

    return (
        // Outside every provider on purpose. A boundary below ThemeProvider
        // cannot catch ThemeProvider failing, and the providers are exactly the
        // code whose failure takes the whole app to a blank window.
        <ErrorBoundary label="root">
            <GestureHandlerRootView style={{ flex: 1 }}>
                <SafeAreaProvider>
                    <QueryClientProvider client={queryClient}>
                        <ThemeProvider>
                            <ToastProvider>
                                <AuthProvider>
                                    <BrandingSync />
                                    <LocaleSync />
                                    <ThemedChrome />
                                    <ShareIntentGate />
                                    <NotificationPlumbing fontsLoaded={fontsLoaded} />
                                    <AuthGate fontsLoaded={fontsLoaded} />
                                    <RecoveryKeyOverlay />
                                </AuthProvider>
                            </ToastProvider>
                        </ThemeProvider>
                    </QueryClientProvider>
                </SafeAreaProvider>
            </GestureHandlerRootView>
        </ErrorBoundary>
    );
}

/** Status bar and window background follow the theme, not the OS setting. */
function ThemedChrome() {
    const theme = useTheme();
    useEffect(() => {
        void SystemUI.setBackgroundColorAsync(
            theme.colors.bgPrimary,
        );
    }, [theme]);
    return <StatusBar style={theme.dark ? 'light' : 'dark'} />;
}

/**
 * The recovery key, shown over whatever is on screen.
 *
 * This has to live at the root, and that is not a stylistic choice. The server
 * mints a recovery key DURING a password or MFA sign-in, which sets the stage
 * to 'signed-in' — at which point the gate replaces to /(tabs) and the
 * onboarding screens unmount. Rendered anywhere below this, the key would be
 * torn down in the same frame it arrived.
 *
 * It is shown exactly once and cannot be recovered by anyone, including the
 * server, so losing it here means losing access to encrypted data. Hence an
 * overlay that outlives the navigation, and a card the user must explicitly
 * acknowledge.
 */
function RecoveryKeyOverlay() {
    const { pendingRecoveryKey, acknowledgeRecoveryKey } = useAuth();
    const theme = useTheme();
    if (!pendingRecoveryKey) return null;
    return (
        <View
            style={[
                StyleSheet.absoluteFill,
                {
                    backgroundColor: theme.colors.bgPrimary,
                    padding: theme.spacing.lg,
                    justifyContent: 'center',
                    zIndex: 100,
                },
            ]}
        >
            <RecoveryKeyCard secret={pendingRecoveryKey} onConfirm={acknowledgeRecoveryKey} />
        </View>
    );
}

/**
 * Background notification polling, and what happens when one is tapped.
 *
 * Registration is tied to being signed in rather than to opening the inbox:
 * a user who never visits that screen should still be told when something
 * happens. See src/features/notifications/README.md for why this app polls
 * instead of using Firebase.
 */
function NotificationPlumbing({ fontsLoaded }: { fontsLoaded: boolean }) {
    const { stage } = useAuth();
    const theme = useTheme();
    const router = useRouter();

    useEffect(() => {
        if (stage.kind !== 'signed-in') return;
        void registerNotificationPolling();
    }, [stage.kind]);

    // Warm taps: the app is running, the listener hears the response as it
    // happens. The payload's `link` is the server's WEB path (`/app/...`) and
    // must be translated before it goes anywhere near the router — pushed
    // raw, it matches no native route and lands on +not-found. The claim
    // helper always answers with a real screen (the translated destination,
    // or the inbox), and answers null for a response the cold-start path
    // below already routed.
    useEffect(() => {
        const sub = Notifications.addNotificationResponseReceivedListener((response) => {
            const route = claimPushResponse(response);
            if (route) router.push(route as never);
        });
        return () => sub.remove();
    }, [router]);

    // Cold-start taps: a tap that LAUNCHES the app delivers its response
    // before the listener above exists, so it has to be fetched back. Two
    // constraints decide the timing, and both mirror AuthGate's `ready`:
    //   - AuthGate renders the <Stack> only once fonts + theme + stage are
    //     settled, so pushing earlier would address a navigator that is not
    //     mounted yet;
    //   - once ready flips, AuthGate's own effect runs its replace() FIRST
    //     (it is synchronous; this path awaits the native module), so the
    //     push lands ON TOP of the stage's home screen and the back button
    //     unwinds to somewhere sensible instead of out of the app.
    // Signed-in only: a lapsed session shows login first, and this effect
    // re-fires when the stage reaches signed-in — the claim ledger is what
    // makes that re-fire safe.
    const coldStartReady = fontsLoaded && theme.hydrated && stage.kind === 'signed-in';
    useEffect(() => {
        if (!coldStartReady) return;
        let cancelled = false;
        Notifications.getLastNotificationResponseAsync()
            .then((response) => {
                if (cancelled || !response) return;
                const route = claimPushResponse(response);
                if (route) router.push(route as never);
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

/**
 * Route the user to the screen their auth stage demands.
 *
 * Every stage maps to exactly one route group. Redirecting from an effect
 * rather than rendering a <Redirect> keeps the navigation state honest — the
 * user can still use the hardware back button inside a group.
 */
function AuthGate({ fontsLoaded }: { fontsLoaded: boolean }) {
    const { stage } = useAuth();
    const theme = useTheme();
    const router = useRouter();
    const segments = useSegments();

    // `theme.hydrated` is in here so the splash covers the theme's disk read.
    // Without it the first frames paint from the DEVICE colour scheme while the
    // stored/account theme is still being read, so a light account on a dark
    // phone flashed black on every cold start.
    const ready = fontsLoaded && stage.kind !== 'loading' && theme.hydrated;

    useEffect(() => {
        if (ready) void SplashScreen.hideAsync();
    }, [ready]);

    useEffect(() => {
        if (!ready) return;
        const group = segments[0];
        const target = ROUTE_FOR_STAGE[stage.kind];
        // `signed-in` is the only stage with a whole tree behind it; anywhere
        // inside (tabs) is a legitimate place to be.
        if (stage.kind === 'signed-in') {
            if (group === '(onboarding)') router.replace('/(tabs)');
            return;
        }
        if (segments.join('/') !== target.replace(/^\//, '')) router.replace(target as never);
    }, [ready, stage.kind, segments, router]);

    if (!ready) return null;

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.bgPrimary },
                // Android's default is a fade; a slide reads as depth and makes
                // "back" feel like an undo rather than a jump.
                animation: 'slide_from_right',
            }}
        >
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
                name="chat/[id]"
                options={{ animation: 'slide_from_right' }}
            />
        </Stack>
    );
}

const ROUTE_FOR_STAGE: Record<ReturnType<typeof useAuth>['stage']['kind'], string> = {
    loading: '/(onboarding)/server',
    'needs-server': '/(onboarding)/server',
    // Not a sign-out. See app/(onboarding)/unreachable.tsx.
    unreachable: '/(onboarding)/unreachable',
    'signed-out': '/(onboarding)/login',
    'mfa-required': '/(onboarding)/mfa',
    'mfa-setup-required': '/(onboarding)/mfa-setup',
    'email-verification-required': '/(onboarding)/verify-email',
    'encryption-setup-required': '/(onboarding)/encryption-setup',
    'encryption-pin-required': '/(onboarding)/encryption-pin',
    'pending-approval': '/(onboarding)/pending-approval',
    locked: '/(onboarding)/locked',
    'signed-in': '/(tabs)',
};
