// Organisation groups — the ONE read of GET /auth/groups (the auth router is
// mounted at the root: `/auth/groups`, not `/api/auth/groups`).
//
// The pickers that offer "share with a group" each used to carry their own
// copy of this fetch. They all treat a refusal (the caller lacks
// manage_users, the feature is off) as "no groups to offer", which is why the
// reader answers null on a non-2xx instead of throwing: a caller that keeps
// what it has on a refusal can, and one that wants an empty list writes
// `?? []`. A network failure still throws, as the hand-written copies did.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** One group row as GET /auth/groups returns it; pickers read id and name. */
export interface OrgGroup {
    id: string;
    name?: string;
    organizationId?: string | null;
    [key: string]: unknown;
}

export const orgGroupKeys = {
    all: ['orgGroups'] as const,
    list: () => [...orgGroupKeys.all, 'list'] as const,
};

/** The rows of an answer: a bare array, or `{ groups: [...] }`; anything else is none. */
export function groupRowsOf(data: unknown): OrgGroup[] {
    if (Array.isArray(data)) return data as OrgGroup[];
    const groups = (data as { groups?: unknown } | null)?.groups;
    return Array.isArray(groups) ? (groups as OrgGroup[]) : [];
}

/** The caller's org groups, or null when the server refused (non-2xx). */
export async function readOrgGroups(signal?: AbortSignal): Promise<OrgGroup[] | null> {
    const res = await authFetch(`${API_BASE}/auth/groups`, signal ? { signal } : undefined);
    if (!res.ok) return null;
    return groupRowsOf(await res.json());
}

/** The caller's org groups through the shared cache; a refusal reads as []. */
export function useOrgGroupsQuery(enabled = true) {
    return useQuery<OrgGroup[], Error>({
        queryKey: orgGroupKeys.list(),
        queryFn: async ({ signal }) => (await readOrgGroups(signal)) ?? [],
        enabled,
    });
}
