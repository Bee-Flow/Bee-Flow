// Model tiers for the AI composers — the ONLY place that knows the
// /ai/config/tiers-for-user wire contract.
//
// The list is permission- and task-aware: a custom tier appears only when the
// user's groups grant access AND the tier is allowed for that task type. Both
// builders and the CMS assistant mount a composer that asks for the same
// task type, so sharing one cached answer is the point.
//
// `authFetch` rather than `apiClient`: a tier list that fails to load leaves
// the picker on 'auto', which is a working choice — there is no error body to
// shape, and the consuming screens mock `authFetch` directly.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** One tier slot as /ai/config/tiers-for-user returns it. A standard tier is
 *  only offered once it has a modelId; custom tiers carry their own labels. */
export interface ModelTierConfig {
    modelId?: string | null;
    label?: string | null;
    icon?: string | null;
    description?: string | null;
}

export type ModelTierMap = Record<string, ModelTierConfig>;

export const modelTierKeys = {
    all: ['model-tiers'] as const,
    forTask: (taskType: string) => [...modelTierKeys.all, taskType] as const,
};

export async function fetchModelTiers(taskType: string, signal?: AbortSignal): Promise<ModelTierMap> {
    const res = await authFetch(
        `${API_BASE}/ai/config/tiers-for-user?taskType=${encodeURIComponent(taskType)}`,
        { signal },
    );
    if (!res.ok) throw new Error(`tiers-for-user ${res.status}`);
    return res.json();
}

export function useModelTiersQuery(taskType: string) {
    return useQuery<ModelTierMap, Error>({
        queryKey: modelTierKeys.forTask(taskType),
        queryFn: ({ signal }) => fetchModelTiers(taskType, signal),
        // Group membership and tier configuration change on an admin's clock,
        // not the composer's; one read per session per task type is plenty.
        staleTime: Infinity,
        retry: false,
    });
}
