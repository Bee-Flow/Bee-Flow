/**
 * The signed-out stack.
 *
 * Ten routes, one per auth stage (app/_layout.tsx ROUTE_FOR_STAGE). None of
 * them is reached by the user navigating — the gate `replace`s to whichever
 * one the current stage demands — so there is nothing to swipe back to, and
 * offering the gesture would only produce a screen the gate immediately undoes.
 *
 * The transition is a fade rather than the app's usual slide for the same
 * reason: these screens do not sit next to each other in any hierarchy the
 * user could reason about. Sliding implies a "back"; fading implies a change
 * of state, which is what actually happened.
 */

import { Stack } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';

export default function OnboardingLayout() {
    const theme = useTheme();
    return (
        <Stack
            screenOptions={{
                headerShown: false,
                gestureEnabled: false,
                animation: 'fade',
                animationDuration: theme.motion.base,
                contentStyle: { backgroundColor: theme.colors.bgPrimary },
            }}
        />
    );
}
