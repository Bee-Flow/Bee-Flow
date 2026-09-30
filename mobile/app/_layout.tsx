/**
 * Root layout: providers, fonts, and the gate that decides whether the user
 * sees the app or one of the eight ways in.
 *
 * The gate lives here rather than in each screen because expo-router mounts
 * routes eagerly — a chat screen that renders before we know who is signed in
 * would fire its queries, take a 401, and bounce the whole stack.
 *
 * Core plumbing (error boundary, query client, theme, platform bridges) is in
 * src/core/providers; this file composes it with the shared and feature layers,
 * which core may not import.
 */

import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';

import { AuthProvider, useAuth } from '@/core/auth/AuthProvider';
import { ErrorBoundary } from '@/core/diagnostics/ErrorBoundary';
import { installGlobalErrorHandler } from '@/core/diagnostics/report';
import { installNetworkBridges, RootProviders, useAppFonts } from '@/core/providers';
import { useTheme } from '@/core/theme/ThemeProvider';
import { BrandingSync } from '@/features/appearance';
import { NotificationBell, NotificationPlumbing, translateWebLink } from '@/features/notifications';
import { RecoveryKeyOverlay } from '@/features/onboarding';
import { ShareIntentGate } from '@/features/search';
import { LocaleSync } from '@/features/settings';
import { MarkdownLinkProvider } from '@/shared/markdown';
import { ConfirmProvider } from '@/shared/patterns';
import { HeaderAccessoryProvider, HeaderSearchButton, ToastProvider } from '@/shared/ui';

// Search and the bell, on every ScreenHeader. Supplied here because the bell
// polls an API the UI kit may not call (see shared/ui/headerAccessories.tsx).
const HEADER_ACCESSORIES = [HeaderSearchButton, NotificationBell];

// Held until the auth stage is known, so the app never flashes a login screen
// at someone who is already signed in.
void SplashScreen.preventAutoHideAsync();

// At module scope, not in an effect: a throw during the first render of the
// tree happens before any effect runs, and that is precisely the crash worth
// catching. The network bridges likewise exist before the first request.
installGlobalErrorHandler();
installNetworkBridges();

export default function RootLayout() {
    const fontsLoaded = useAppFonts();

    return (
        // Outside every provider on purpose. A boundary below ThemeProvider
        // cannot catch ThemeProvider failing, and the providers are exactly the
        // code whose failure takes the whole app to a blank window.
        <ErrorBoundary label="root">
            <RootProviders>
                <ToastProvider>
                    <ConfirmProvider>
                        <HeaderAccessoryProvider accessories={HEADER_ACCESSORIES}>
                            {/* A link in an answer to one of the app's own
                                screens opens it here, via the notification table. */}
                            <MarkdownLinkProvider translate={translateWebLink}>
                                <AuthProvider>
                                    <BrandingSync />
                                    <LocaleSync />
                                    <ShareIntentGate />
                                    <NotificationPlumbing fontsLoaded={fontsLoaded} />
                                    <AuthGate fontsLoaded={fontsLoaded} />
                                    <RecoveryKeyOverlay />
                                </AuthProvider>
                            </MarkdownLinkProvider>
                        </HeaderAccessoryProvider>
                    </ConfirmProvider>
                </ToastProvider>
            </RootProviders>
        </ErrorBoundary>
    );
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
        // outside (onboarding) is a legitimate place to be.
        if (stage.kind === 'signed-in') {
            if (group === '(onboarding)') router.replace('/');
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
            {/* The drawer and its tabs. Everything else is a sibling of it in
                this Stack, so a detail screen pushes over the whole drawer. */}
            <Stack.Screen name="(drawer)" />
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
    'signed-in': '/',
};
