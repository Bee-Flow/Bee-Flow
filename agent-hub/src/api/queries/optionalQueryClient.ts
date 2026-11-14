// For a component that also renders without a QueryClientProvider: the App
// Studio runtime's headless mount (the render service's screenshots) has none.
// There the component's queries are off and nothing is fetched; everywhere else
// (main.tsx mounts the provider) they read as usual.

import { useContext } from 'react';
import { QueryClient, QueryClientContext } from '@tanstack/react-query';

const DETACHED_CLIENT = new QueryClient();

/** The provider's client and whether there is one; pass `client` as useQuery's/useMutation's second argument. */
export function useOptionalQueryClient(): { client: QueryClient; attached: boolean } {
    const client = useContext(QueryClientContext);
    return { client: client || DETACHED_CLIENT, attached: !!client };
}
