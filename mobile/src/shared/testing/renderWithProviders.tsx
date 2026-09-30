/**
 * Render a component inside the providers every screen has at runtime: safe
 * area (with fixed metrics — there is no native module to measure), React
 * Query and the theme. Test-only; nothing in the app imports this.
 *
 * `render` is async in @testing-library/react-native 14, so this is too.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/core/theme/ThemeProvider';
import { ConfirmProvider } from '@/shared/patterns';
import { ToastProvider } from '@/shared/ui';

export const TEST_METRICS = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

/**
 * A client that never retries and never schedules garbage collection — for
 * mutations too: a finished mutation's five-minute gc timer otherwise keeps
 * Jest from exiting after a test that submitted something.
 */
export function testQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
}

export async function renderWithProviders(
    ui: ReactElement,
    { queryClient = testQueryClient() }: { queryClient?: QueryClient } = {},
): Promise<{ queryClient: QueryClient }> {
    await render(
        <SafeAreaProvider initialMetrics={TEST_METRICS}>
            <QueryClientProvider client={queryClient}>
                <ThemeProvider>{ui}</ThemeProvider>
            </QueryClientProvider>
        </SafeAreaProvider>,
    );
    return { queryClient };
}

/**
 * A whole screen: the providers above plus the toast and the confirm sheet
 * that app/_layout.tsx mounts, for screens whose actions toast or ask first.
 */
export async function renderScreen(ui: ReactElement, options: { queryClient?: QueryClient } = {}): Promise<{ queryClient: QueryClient }> {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
        options,
    );
}

/**
 * Pull a scroll view's RefreshControl. The react-native jest preset mocks
 * RefreshControl to a bare host with no props, so the handler is read off the
 * `refreshControl` element the scroll view was given.
 */
export function pullToRefresh(scrollView: { props: Record<string, unknown> } | undefined): void {
    const control = scrollView?.props.refreshControl as { props?: { onRefresh?: () => void } } | undefined;
    const onRefresh = control?.props?.onRefresh;
    if (!onRefresh) throw new Error('pullToRefresh: this scroll view has no refreshControl');
    onRefresh();
}
