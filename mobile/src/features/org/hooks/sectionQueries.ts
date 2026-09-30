/**
 * Queries for the org-admin settings sections. Each takes the org id (or an
 * `enabled` flag) the screen resolved from useOrgContext, and asks only when
 * the caller is an org admin — the endpoints refuse anyone else.
 */

import { useQuery } from '@tanstack/react-query';

import { getAcademyOverview, getIconPacks, getOrgTheme } from '../api/branding';
import { orgKeys } from '../api/keys';
import { getOrgAiContext, getOrgEncryption, getOrgIntegrationCache } from '../api/policies';
import { getOrgLanguages } from '../api/profile';

/** An org-scoped settings query: off without an org id or admin rights, never retried on a refusal. */
function orgScoped<T>(key: readonly unknown[], orgId: string | null, fetch: (id: string, signal: AbortSignal) => Promise<T>) {
    return {
        queryKey: key,
        queryFn: ({ signal }: { signal: AbortSignal }) => fetch(orgId as string, signal),
        enabled: Boolean(orgId),
        retry: false,
    } as const;
}

export function useOrgLanguages(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.languages,
        queryFn: ({ signal }) => getOrgLanguages(signal),
        enabled,
        retry: false,
    });
}

export function useOrgEncryption(orgId: string | null) {
    return useQuery(orgScoped(orgKeys.encryption(orgId ?? 'none'), orgId, getOrgEncryption));
}

export function useOrgAiContext(orgId: string | null) {
    return useQuery(orgScoped(orgKeys.aiContext(orgId ?? 'none'), orgId, getOrgAiContext));
}

export function useOrgIntegrationCache(orgId: string | null) {
    return useQuery(orgScoped(orgKeys.integrationCache(orgId ?? 'none'), orgId, getOrgIntegrationCache));
}

export function useOrgTheme(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.theme,
        queryFn: ({ signal }) => getOrgTheme(signal),
        enabled,
        retry: false,
    });
}

export function useIconPacks(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.iconPacks,
        queryFn: ({ signal }) => getIconPacks(signal),
        enabled,
        retry: false,
    });
}

/** The server caches the aggregation for 60 s, so a minute here costs nothing. */
export function useAcademyOverview(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.academy,
        queryFn: ({ signal }) => getAcademyOverview(signal),
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}
