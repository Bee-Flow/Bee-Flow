// The providers the backend lists and every model they offer, read through the
// query cache (GET /ai/providers, GET /ai/providers/:id/models). The models are
// only read while `modelsEnabled` is set, the sections that show them.

import { useCallback, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import type { CatalogModel } from '../chatModelTiers/tierTypes';
import { aiProvidersKey, useAiProvidersQuery } from '@/api/queries/adminConfigReads';
import { readOrNull } from '@/api/queries/refusableRead';
import { API_BASE } from '@/utils/helpers';

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

const combine = (results: { data?: ModelsAnswer | null; isFetching: boolean }[]) => ({
    answers: results.map(r => r.data),
    loading: results.some(r => r.isFetching),
});

export function useAiProviderModels(modelsEnabled: boolean) {
    const queryClient = useQueryClient();
    const providersQuery = useAiProvidersQuery<ProviderRow>();
    const providers = providersQuery.data ?? NO_PROVIDERS;

    const { answers, loading } = useQueries({
        queries: providers.map(provider => ({
            queryKey: [...modelsKeyPrefix, provider.id],
            queryFn: ({ signal }: { signal: AbortSignal }) => readOrNull<ModelsAnswer>(`${API_BASE}/ai/providers/${provider.id}/models`, signal),
            enabled: modelsEnabled,
            staleTime: 0,
            retry: false,
        })),
        combine,
    });

    const allModels = useMemo<ModelRow[]>(
        () => providers.flatMap((provider, i) => (answers[i]?.models || []).map(m => ({
            ...m,
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.type,
        }))),
        [providers, answers],
    );

    /** Read both lists again (a runtime was connected or a model pulled). */
    const refresh = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: aiProvidersKey });
        void queryClient.invalidateQueries({ queryKey: modelsKeyPrefix });
    }, [queryClient]);

    return { providers, providersLoading: providersQuery.isPending, allModels, loadingModels: loading, refresh };
}
