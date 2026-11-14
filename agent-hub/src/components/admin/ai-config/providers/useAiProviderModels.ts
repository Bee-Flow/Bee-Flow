// The providers the backend lists and every model they offer, read through the
// query cache (GET /ai/providers, GET /ai/providers/:id/models). The models are
// only read while `modelsEnabled` is set, the sections that show them.

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogModel } from '../chatModelTiers/tierTypes';
import { aiProvidersKey, useAiProvidersQuery } from '@/api/queries/adminConfigReads';
import { readOrNull } from '@/api/queries/refusableRead';
import { apiUrl } from '@/api/typedRequest';

/** A provider as GET /ai/providers lists it. */
export interface ProviderRow {
    id: string;
    name?: string;
    type?: string;
}

/** A provider's model, stamped with the provider it came from. */
export interface ModelRow extends CatalogModel {
    name?: string;
    providerId: string;
    providerType?: string;
}

const modelsKeyPrefix = ['admin-config', 'ai-provider-models'] as const;
const NO_PROVIDERS: ProviderRow[] = [];

interface ModelsAnswer { models?: CatalogModel[] }

const NO_MODELS: ModelRow[] = [];

/**
 * Every provider's models in one query. Deliberately one `useQuery` and not
 * `useQueries`: the latter pulls query-core's QueriesObserver into this lazy
 * chunk, and the first-load vendor-misc chunk then imports it from here, so
 * every page preloads the admin dashboard (bundle budget).
 */
async function readAllModels(providers: ProviderRow[], signal: AbortSignal): Promise<ModelRow[]> {
    const answers = await Promise.all(
        providers.map(p => readOrNull<ModelsAnswer>(apiUrl('GET /ai/providers/{id}/models', { params: { id: p.id } }), signal).catch(() => null)),
    );
    return providers.flatMap((provider, i) => (answers[i]?.models || []).map(m => ({
        ...m,
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
    })));
}

export function useAiProviderModels(modelsEnabled: boolean) {
    const queryClient = useQueryClient();
    const providersQuery = useAiProvidersQuery<ProviderRow>();
    const providers = providersQuery.data ?? NO_PROVIDERS;

    const providerIds = useMemo(() => providers.map(p => p.id), [providers]);
    const modelsQuery = useQuery({
        queryKey: [...modelsKeyPrefix, providerIds],
        queryFn: ({ signal }) => readAllModels(providers, signal),
        enabled: modelsEnabled && providers.length > 0,
        staleTime: 0,
        retry: false,
    });
    const allModels = modelsQuery.data ?? NO_MODELS;

    /** Read both lists again (a runtime was connected or a model pulled). */
    const refresh = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: aiProvidersKey });
        void queryClient.invalidateQueries({ queryKey: modelsKeyPrefix });
    }, [queryClient]);

    return { providers, providersLoading: providersQuery.isPending, allModels, loadingModels: modelsQuery.isFetching, refresh };
}
