/**
 * The app-wide providers core owns, in the order they depend on each other:
 * gestures, safe area, React Query, theme (with the themed status bar, and the
 * font files it may ask for).
 * app/_layout.tsx puts the root ErrorBoundary around this and the shared and
 * feature layers inside it; core may not import those, so they are composed
 * there.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/core/theme/ThemeProvider';

import { FONT_RUNTIME } from './fonts';
import { useAppStateFocus } from './platformBridges';
import { queryClient } from './queryClient';
import { ThemedChrome } from './ThemedChrome';

export function RootProviders({ children }: { children: ReactNode }) {
    useAppStateFocus();
    return (
        <GestureHandlerRootView style={styles.fill}>
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <ThemeProvider fonts={FONT_RUNTIME}>
                        <ThemedChrome />
                        {children}
                    </ThemeProvider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
});
