// The caller's own organisation's Cowork policy (GET /api/cowork/policy/mine, core/entitlements/coworkPolicy.mts):
// what the app picker of a cowork may offer. The admin panel reads and writes an organisation's policy by id.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export interface MyCoworkPolicy {
    ceiling: 'asks_everything' | 'asks_before_sending' | 'on_its_own';
    readOnly: boolean;
    /** The apps a cowork may use while nobody watches; null: every app. */
    unattendedApps: string[] | null;
    unreadable?: boolean;
}

export function useMyCoworkPolicy() {
    return useQuery<MyCoworkPolicy, Error>({
        queryKey: ['cowork', 'policy', 'mine'],
        queryFn: () => apiJson<'GET /api/cowork/policy/mine', MyCoworkPolicy>('GET /api/cowork/policy/mine'),
        staleTime: 60_000,
        retry: false,
    });
}
