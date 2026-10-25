// Shared render helpers for tests that need app providers.
//
// Replaces the per-file `withClient(children)` wrappers that each re-created a
// retry-disabled QueryClient (e.g. hooks/*.test.tsx).
import React from 'react';
import { render, renderHook, type RenderHookOptions, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** A QueryClient with retries disabled — deterministic for tests. */
export function makeTestQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Wrap UI in a fresh retry-disabled QueryClientProvider. */
export function withQueryClient(ui: React.ReactNode): React.ReactElement {
    return <QueryClientProvider client={makeTestQueryClient()}>{ui}</QueryClientProvider>;
}

/** One client for the life of a render, as the `wrapper` option, so a rerender keeps it. */
function clientWrapper() {
    const client = makeTestQueryClient();
    return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
}

/** render() inside a fresh retry-disabled QueryClientProvider; rerender keeps the same client. */
export function renderWithClient(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
    return render(ui, { ...options, wrapper: clientWrapper() });
}

/** renderHook() inside one retry-disabled QueryClientProvider that lives as long as the hook. */
export function renderHookWithClient<Result, Props>(hook: (props: Props) => Result, options?: Omit<RenderHookOptions<Props>, 'wrapper'>) {
    return renderHook(hook, { ...options, wrapper: clientWrapper() });
}
