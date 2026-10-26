// Reads the app shell polls or loads once: the sidebar's Approvals row, the
// settings shell's counters and statuses, and the Privacy Shield environment.

import { useRef } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { settled } from '../settled';
import { settingsShellApi } from '../settingsShellApi';

const shellKeys = {
    approvals: (isOrgAdmin: boolean) => ['shell', 'approvals', isOrgAdmin] as const,
    settings: (name: string, ...rest: unknown[]) => ['shell', 'settings', name, ...rest] as const,
    shield: (name: string) => ['shell', 'org-shield', name] as const,
};

/** Every status bucket added up: "does this person have approvals at all". */
const facetTotal = (facets?: { status?: Record<string, unknown> } | null): number => Object.values(facets?.status || {})
    .reduce((n: number, v: unknown) => n + (Number(v) || 0), 0);

export interface ApprovalsNav { pendingCount: number; hasApprovals: boolean }

/**
 * How many decisions wait on this person, and whether the Approvals row belongs
 * in the menu: they are part of ANY approval, in any status. An org admin's own
 * empty inbox is not an empty section, so the org scope is asked too, once, and
 * remembered through `orgHasApprovals` (an organisation that has approvals does
 * not stop having them). Polled every 30 s; a hidden tab neither polls nor is
 * stale when it comes back (focus refetches). A failed poll keeps the last shape.
 */
export function useApprovalsNavQuery(enabled: boolean, isOrgAdmin: boolean) {
    // Asked once, then remembered: an admin with a permanently empty personal
    // inbox would otherwise pay for the org probe on every single poll, forever.
    const orgHasApprovals = useRef(false);
    return useQuery<ApprovalsNav, Error>({
        queryKey: shellKeys.approvals(isOrgAdmin),
        enabled,
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${API_BASE}/api/automation/approvals/facets?scope=mine`, { signal });
            if (!res.ok) throw new Error(`approvals facets ${res.status}`);
            const data = await res.json();
            let hasAny = facetTotal(data?.facets) > 0;
            if (!hasAny && isOrgAdmin) {
                if (orgHasApprovals.current) {
                    hasAny = true;
                } else {
                    // 403 when the session's role no longer carries the org
                    // scope: then the personal answer is the whole answer.
                    const orgRes = await authFetch(`${API_BASE}/api/automation/approvals/facets?scope=org`, { signal });
                    if (orgRes.ok) hasAny = facetTotal((await orgRes.json())?.facets) > 0;
                    orgHasApprovals.current = hasAny;
                }
            }
            return { pendingCount: Number(data?.facets?.status?.pending) || 0, hasApprovals: hasAny };
        },
    });
}

/** One settings-shell GET that is a state when it fails: null for a non-ok answer. */
function useShellRead<T>(key: readonly unknown[], read: () => Promise<Response>, enabled = true): UseQueryResult<T | null, Error> {
    return useQuery<T | null, Error>({
        queryKey: key,
        enabled,
        queryFn: async () => {
            const res = await read();
            return res.ok ? ((await res.json()) as T) : null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The agents the Preferences section lists. */
export const useSettingsAgentsQuery = <T,>() => useShellRead<T[]>(shellKeys.settings('agents'), settingsShellApi.agents);
/** The memory counters; a non-ok answer or a network failure is an error state (the panel never paints a zero for it). */
export function useMemoryStatsQuery<T>() {
    return useQuery<T, Error>({
        queryKey: shellKeys.settings('memory-stats'),
        queryFn: async () => {
            const res = await settingsShellApi.memoryStats();
            if (!res.ok) throw new Error(`memory stats ${res.status}`);
            return res.json() as Promise<T>;
        },
        staleTime: 0,
        retry: false,
    });
}
/** The organisations the caller can see (for the sign-in-method lock). */
export const useSettingsOrganizationsQuery = <T,>(enabled: boolean) => useShellRead<T[]>(shellKeys.settings('organizations'), settingsShellApi.organizations, enabled);
/** The integration statuses of the settings shell. */
export const useUserSettingsQuery = <T,>() => useShellRead<T>(shellKeys.settings('user-settings'), settingsShellApi.userSettings);
export const useLinkedinStatusQuery = <T,>() => useShellRead<T>(shellKeys.settings('linkedin'), settingsShellApi.linkedinStatus);
export const useAppPasswordStatusQuery = <T,>() => useShellRead<T>(shellKeys.settings('app-password'), settingsShellApi.appPasswordStatus);
export const useGithubStatusQuery = <T,>() => useShellRead<T>(shellKeys.settings('github'), settingsShellApi.githubStatus);

/** One Privacy Shield environment read; null when the endpoint refused or is unreachable. */
function useShieldRead<T>(name: string, path: string) {
    return useQuery<T | null, Error>({
        queryKey: shellKeys.shield(name),
        queryFn: async () => {
            const res = await settled(`${API_BASE}${path}`, undefined, 'empty');
            return res.ok ? ((await res.res.json()) as T) : null;
        },
        staleTime: 0,
        retry: false,
    });
}
export const useShieldAiConfigQuery = <T,>() => useShieldRead<T>('ai-config', '/ai/config');
export const useShieldEuModelsQuery = <T,>() => useShieldRead<T>('eu-models', '/ai/config/chat-models-eu');
export const useShieldGuardStatusQuery = <T,>() => useShieldRead<T>('guard-status', '/api/org-privacy-shield/user/guard-status');
export const useShieldOrganizationsQuery = <T,>() => useShieldRead<T[]>('organizations', '/auth/organizations');
