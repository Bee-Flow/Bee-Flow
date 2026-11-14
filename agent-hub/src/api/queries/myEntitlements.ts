// GET /auth/my-entitlements: what this user may use (the unified resolver
// snapshot). Read on mount and again whenever the session changes; a refusal
// (401 before login) or a failure is the query's error, and the last snapshot
// stays.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export function useMyEntitlementsQuery<T>() {
    return useQuery<T, Error>({
        queryKey: ['auth', 'my-entitlements'],
        ...READ_ONCE,
        queryFn: () => apiJson<'GET /auth/my-entitlements', T>('GET /auth/my-entitlements'),
    });
}
