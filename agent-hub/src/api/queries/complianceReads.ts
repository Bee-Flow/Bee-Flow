// Compliance Center reads that are one GET each: fetchJson (the hub's JSON
// helper, which throws on a non-ok answer) plus a tolerant parse. A parse that
// returns null is "the endpoint answered something unusable": the query errors,
// and the page says it could not read it - never a silent zero.

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../complianceApi';

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
