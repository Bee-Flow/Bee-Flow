import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactElement, type ReactNode } from 'react';

/**
 * The data layer, for a test that renders a tree reaching it.
 *
 * Anything that reads through `api/queries/` needs a QueryClient above it, and
 * the app mounts one in main.jsx. A test mounts its own — one per test, never
 * the app's singleton, so one case cannot serve another case's cached answer.
 *
 * `retry: false` because the client's production default (two retries with
 * backoff) would make every failure case wait out the backoff before the
 * assertion can see it.
 */
export function testQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
}

/** Wrap one element: `render(withQueryClient(<AgentHub … />))`. */
export function withQueryClient(ui: ReactElement, client: QueryClient = testQueryClient()): ReactElement {
    return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** The `wrapper` option of renderHook, bound to one client. */
export function queryWrapper(client: QueryClient = testQueryClient()) {
    return function QueryWrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
}
