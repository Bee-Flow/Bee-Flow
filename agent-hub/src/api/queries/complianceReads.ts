// Compliance Center reads that are one GET each: fetchJson (the hub's JSON
// helper, which throws on a non-ok answer) plus a tolerant parse. A parse that
// returns null is "the endpoint answered something unusable": the query errors,
// and the page says it could not read it - never a silent zero.

import { useQuery } from '@tanstack/react-query';
import { API, fetchJson } from '../complianceApi';
import { readOrNull } from './refusableRead';

export function useComplianceRead<T>(key: readonly unknown[], url: string, parse: (body: unknown) => T | null, enabled = true) {
    return useQuery<T, Error>({
        queryKey: ['compliance', 'read', ...key],
        enabled,
        queryFn: async () => {
            const parsed = parse(await fetchJson(url));
            if (parsed === null) throw new Error('unusable answer');
            return parsed;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The org's published policies with this user's acknowledgement state; a refusal (unlicensed, no access) reads as none. */
export function usePublishedPoliciesQuery<D>() {
    return useQuery<D[], Error>({
        queryKey: ['compliance', 'published-policies'],
        queryFn: async () => {
            const data = await readOrNull<unknown>(`${API}/iso/docs/published/me`);
            return Array.isArray(data) ? data as D[] : [];
        },
        staleTime: 0,
        retry: false,
    });
}

/** One published policy's body; a refusal reads as null (the row stays confirmable without it). */
export function usePolicyBodyQuery(slug: string | null) {
    return useQuery<{ body: string } | null, Error>({
        queryKey: ['compliance', 'policy-body', slug],
        enabled: !!slug,
        queryFn: () => readOrNull<{ body: string }>(`${API}/iso/docs/published/${encodeURIComponent(slug as string)}/body`),
        staleTime: 0,
        retry: false,
    });
}
