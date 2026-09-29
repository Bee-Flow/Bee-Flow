// The step drawer's reads (handoff 5, round 4) — the ONLY place that knows
// the /api/automation/_usage/values wire contract:
//
//   GET /api/automation/_usage/values?tool=<tool>&input=<input key>
//     → [{ value, count }]   the values this organisation typed into that
//                             setting of that action, most used first
//
// Behind the "Frequently used: Documents · Invoices · Photos" chips under a
// setting. The chips are a convenience, so every failure reads as "no
// history": an older server without the route (404), an account that may not
// see it (403), or a network error leave the setting without chips, never
// with an error.

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../client';

export interface UsageValue {
    value: string;
    count: number;
}

export const ndvKeys = {
    all: ['automation', 'ndv'] as const,
    usageValues: (tool: string, input: string) => [...ndvKeys.all, 'usage-values', tool, input] as const,
};

/** Keeps string-able rows with a positive count, most used first, at most `max`. */
export function normaliseUsageValues(rows: unknown, max = 4): UsageValue[] {
    const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' && Array.isArray((rows as { values?: unknown }).values) ? (rows as { values: unknown[] }).values : []);
    const out: UsageValue[] = [];
    const seen = new Set<string>();
    for (const row of list) {
        const r = row as { value?: unknown; count?: unknown } | null;
        if (!r || r.value == null || typeof r.value === 'object') continue;
        const value = String(r.value).trim();
        const count = Number(r.count);
        if (!value || seen.has(value) || !Number.isFinite(count) || count <= 0) continue;
        seen.add(value);
        out.push({ value, count });
    }
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, max);
}

export async function fetchUsageValues(tool: string, input: string, signal?: AbortSignal): Promise<UsageValue[]> {
    try {
        const rows = await apiClient.get<unknown>('/api/automation/_usage/values', { query: { tool, input }, signal, retry: false });
        return normaliseUsageValues(rows);
    } catch {
        return [];
    }
}

export function useUsageValuesQuery(tool: string | null | undefined, input: string | null | undefined) {
    return useQuery<UsageValue[], Error>({
        queryKey: ndvKeys.usageValues(tool || '', input || ''),
        queryFn: ({ signal }) => fetchUsageValues(tool as string, input as string, signal),
        enabled: !!tool && !!input,
        // Counts over weeks of runs; an old answer is as good as a new one.
        staleTime: 10 * 60 * 1000,
        retry: false,
    });
}
