// The compliance hub's spine read: overview, checks and the 90-day score
// history, asked together. The history is optional (its failure reads as no
// history); the overview or the checks failing is the query's error.

import { useQuery } from '@tanstack/react-query';
import { API, fetchJson } from '../complianceApi';
import { READ_ONCE } from './readOnce';

export interface ComplianceCoreAnswer<O, C, H> {
    overview: O;
    checks: C[];
    scoreHistory: H[];
}

const complianceCoreKey = ['compliance', 'core'] as const;

export function useComplianceCoreQuery<O, C, H>() {
    return useQuery<ComplianceCoreAnswer<O, C, H>, Error>({
        queryKey: complianceCoreKey,
        ...READ_ONCE,
        queryFn: async () => {
            const [o, c, hist] = await Promise.all([
                fetchJson(`${API}/overview`),
                fetchJson(`${API}/checks`),
                fetchJson(`${API}/score-history?days=90`).catch(() => []),
            ]);
            return {
                overview: o as O,
                checks: Array.isArray(c) ? c as C[] : [],
                scoreHistory: Array.isArray(hist) ? hist as H[] : [],
            };
        },
    });
}
