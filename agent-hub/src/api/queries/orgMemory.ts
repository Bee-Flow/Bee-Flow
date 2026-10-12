// The organisation's memory settings (routes `${API_BASE}/api/org-memory/:orgId`):
// whether memory is on for the organisation, whether members may opt in to
// sensitive topics, the cap per person, and COUNTS of what is stored. Never
// the content of a memory.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export const ORG_MEMORY_MIN_PER_USER = 50;
export const ORG_MEMORY_MAX_PER_USER = 10000;

export interface OrgMemorySettings {
    enabled: boolean;
    sensitiveOptInAllowed: boolean;
    maxPerUser: number;
}

export interface OrgMemoryStats {
    activeMemories: number;
    users: number;
}

export interface OrgMemoryState {
    settings: OrgMemorySettings;
    stats: OrgMemoryStats;
}

/** What a save answers: the state, and how many sensitive memories turning the permission off deleted. */
export interface OrgMemorySaved extends OrgMemoryState {
    deletedSensitive: number;
}

const BASE = '/api/org-memory';

export const orgMemoryKeys = {
    org: (orgId: string) => ['orgMemory', orgId] as const,
};

function readState(body: Partial<OrgMemoryState> | null, fallbackStats?: OrgMemoryStats): OrgMemoryState {
    const s = body?.settings;
    // Never show a guess as the saved setting: no answer is a failed load.
    if (!s || typeof s.enabled !== 'boolean') throw new Error('Could not read the memory settings');
    return {
        settings: {
            enabled: s.enabled,
            sensitiveOptInAllowed: s.sensitiveOptInAllowed === true,
            maxPerUser: Number(s.maxPerUser) || ORG_MEMORY_MIN_PER_USER,
        },
        stats: {
            activeMemories: Number(body?.stats?.activeMemories ?? fallbackStats?.activeMemories) || 0,
            users: Number(body?.stats?.users ?? fallbackStats?.users) || 0,
        },
    };
}

export function useOrgMemory(orgId: string | null | undefined) {
    return useQuery<OrgMemoryState, Error>({
        queryKey: orgMemoryKeys.org(orgId || ''),
        enabled: !!orgId,
        queryFn: async ({ signal }) => readState(
            await apiClient.get<OrgMemoryState>(`${BASE}/${encodeURIComponent(orgId!)}`, { signal, retry: false }),
        ),
    });
}

export function useSaveOrgMemory(orgId: string) {
    const qc = useQueryClient();
    return useMutation<OrgMemorySaved, Error, OrgMemorySettings>({
        mutationFn: async (settings) => {
            const body = await apiClient.put<OrgMemoryState & { deletedSensitive?: number }>(`${BASE}/${encodeURIComponent(orgId)}`, settings, { retry: false });
            return {
                ...readState(body, qc.getQueryData<OrgMemoryState>(orgMemoryKeys.org(orgId))?.stats),
                deletedSensitive: Number(body?.deletedSensitive) || 0,
            };
        },
        onSuccess: ({ settings, stats }) => { qc.setQueryData<OrgMemoryState>(orgMemoryKeys.org(orgId), { settings, stats }); },
    });
}

/** Delete every memory in the organisation. The server insists on the typed word. */
export function useClearOrgMemory(orgId: string) {
    const qc = useQueryClient();
    return useMutation<{ deleted: number }, Error, void>({
        mutationFn: async () => {
            const body = await apiClient.post<{ deleted?: number }>(
                `${BASE}/${encodeURIComponent(orgId)}/clear`, { confirm: 'DELETE' }, { retry: false },
            );
            return { deleted: Number(body?.deleted) || 0 };
        },
        onSuccess: () => { void qc.invalidateQueries({ queryKey: orgMemoryKeys.org(orgId) }); },
    });
}
