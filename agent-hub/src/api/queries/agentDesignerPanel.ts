// The three lookups the legacy agent designer panel makes when it opens (visible models,
// organisations plus groups, categories). authFetch stays inside queryFn on purpose: the
// panel's tests mock it. A failed read keeps the empty list the panel always started with.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { filterVisibleModels, type ModelEntry } from '../modelMeta';

export const agentDesignerCategoriesKey = ['agentDesignerPanel', 'categories'] as const;

export function useDesignerVisibleModels() {
    return useQuery<ReturnType<typeof filterVisibleModels>, Error>({
        queryKey: ['agentDesignerPanel', 'models'],
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/agents/meta/models`);
            const data = await res.json();
            return data.models ? filterVisibleModels(data.models as ModelEntry[]) : [];
        },
        staleTime: 0,
        retry: false,
    });
}

export function useDesignerOrgsAndGroups<TOrg, TGroup>() {
    return useQuery<{ organizations: TOrg[]; groups: TGroup[] }, Error>({
        queryKey: ['agentDesignerPanel', 'orgsAndGroups'],
        queryFn: async () => {
            const [orgsRes, groupsRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/organizations`),
                authFetch(`${API_BASE}/auth/groups`),
            ]);
            const orgsData = orgsRes.ok ? await orgsRes.json() : null;
            const groupsData = groupsRes.ok ? await groupsRes.json() : null;
            return {
                organizations: Array.isArray(orgsData) ? orgsData : [],
                groups: Array.isArray(groupsData) ? groupsData : [],
            };
        },
        staleTime: 0,
        retry: false,
    });
}

export function useDesignerCategories<T>() {
    return useQuery<T[], Error>({
        queryKey: agentDesignerCategoriesKey,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/agents/categories`);
            const data = res.ok ? await res.json() : [];
            return Array.isArray(data) ? data : [];
        },
        staleTime: 0,
        retry: false,
    });
}
