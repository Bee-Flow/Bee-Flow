// The self-hosted runtime catalogue (Ollama, vLLM, ...) and the runtimes the
// customer connected, through the query cache. A customer can connect several
// runtimes under names they choose, so these come from the backend, not from
// the provider registry.

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProviders, fetchRuntimeCatalog } from '@/api/localRuntimeApi';
import type { RuntimeInfo, RuntimeProvider, StarterModel } from '@/api/runtimeTypes';

const localRuntimesKey = ['admin-config', 'local-runtimes'] as const;

interface LocalRuntimesRead {
    runtimes: RuntimeInfo[];
    starterModels: StarterModel[];
    providers: RuntimeProvider[];
    /** A message once this backend turns out to be unable to serve runtimes at all. */
    unsupported: string | null;
}

const NOTHING: LocalRuntimesRead = { runtimes: [], starterModels: [], providers: [], unsupported: null };

export function useLocalRuntimes() {
    const queryClient = useQueryClient();
    const query = useQuery<LocalRuntimesRead, Error>({
        queryKey: localRuntimesKey,
        queryFn: async () => {
            const catalog = await fetchRuntimeCatalog();
            return {
                runtimes: catalog.runtimes,
                starterModels: catalog.starterModels,
                providers: await fetchProviders(),
                unsupported: catalog.supported ? null : catalog.error,
            };
        },
        staleTime: 0,
        retry: false,
    });
    const data = query.data ?? NOTHING;
    const localTypes = new Set(data.runtimes.map(r => r.type));
    const localProviders = data.providers.filter(p => localTypes.has(p.type));

    const reload = useCallback(
        () => queryClient.invalidateQueries({ queryKey: localRuntimesKey }),
        [queryClient],
    );

    return { ...data, localProviders, loading: query.isPending, reload };
}
