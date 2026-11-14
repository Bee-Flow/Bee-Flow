// GET /api/license/status: the licence tier, its source and limits. Read on
// mount and again whenever the session changes; a refusal is an error with the
// HTTP status, and the last answer stays.

import { useQuery } from '@tanstack/react-query';
import { RefusedError } from '../mutate';
import { apiJson } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export const licenseStatusKey = ['license', 'status'] as const;

export function useLicenseStatusQuery<T>() {
    return useQuery<T, Error>({
        queryKey: licenseStatusKey,
        ...READ_ONCE,
        queryFn: async () => {
            try {
                return await apiJson<'GET /api/license/status', T>('GET /api/license/status');
            } catch (err) {
                if (err instanceof RefusedError) throw new Error(`HTTP ${err.status}`);
                throw err;
            }
        },
    });
}
