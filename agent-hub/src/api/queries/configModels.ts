// Model-tier reads shared by the screens that fetch them once per mount, moved
// out of components by scripts/rq-codemod.mjs and merged here (two screens read
// each URL, so they share one hook per URL).
// authFetch stays inside queryFn on purpose: the screens' tests mock authFetch.

import { useQuery } from '@tanstack/react-query';
import { authFetch, API_BASE } from '../../utils/helpers';
import { ApiError } from '../client';
import type { ModelTierMap } from './modelTiers';

export const configModelsKeys = {
    configTiersForUser: ['configModels', 'configTiersForUser'] as const,
    configChatModels: ['configModels', 'configChatModels'] as const,
};

/** GET /ai/config/tiers-for-user?taskType=direct_chat, fresh on every mount. */
export function useConfigTiersForUser() {
    return useQuery<ModelTierMap, Error>({
        queryKey: configModelsKeys.configTiersForUser,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`);
            if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status });
            const json = await res.json();
            return json || {};
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /ai/config/chat-models, `{}` when the server does not answer ok. */
export function useConfigChatModels() {
    return useQuery<ModelTierMap, Error>({
        queryKey: configModelsKeys.configChatModels,
        queryFn: async () => {
            const r = await authFetch(`${API_BASE}/ai/config/chat-models`);
            const data = r.ok ? await r.json() : {};
            return data;
        },
        staleTime: 0,
        retry: false,
    });
}
