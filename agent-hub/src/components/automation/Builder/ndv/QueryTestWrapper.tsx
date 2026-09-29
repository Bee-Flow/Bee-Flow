import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * A fresh, non-retrying QueryClient around a drawer under test. The step
 * drawer's editors read through react-query (the agent step's preview, the
 * "Frequently used" values), so a bare render of NodeDetailView has no client.
 */
export default function QueryTestWrapper({ children }: { children: ReactNode }) {
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
