// MFA enrollment from the gate AuthedApp shows when an account must set up a
// second factor: POST /auth/mfa/setup (the secret and its QR) and POST
// /auth/mfa/enable (the first code, answered with recovery codes).
//
// The setup is a query, not a mount effect: two gates mounting at once (or
// React StrictMode's dev double-invoke) share the one request in flight, so the
// QR on screen always belongs to the secret the session holds. It is not
// cached past the gate (gcTime 0): opening the gate again asks again.

import { useQuery } from '@tanstack/react-query';
import { errorBody, RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';

/** POST /auth/mfa/<path>; a refusal throws the server's error text with its `code`. */
export async function postMfa<T>(path: 'setup' | 'enable', body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
        res = await apiRequest(`POST /auth/mfa/${path}` as const, {
            init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) },
        });
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        const data = errorBody(err) ?? {};
        throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
    }
    return (await res.json().catch(() => ({}))) as T;
}

export function useMfaSetupQuery<T>() {
    return useQuery<T, Error>({
        queryKey: ['auth', 'mfa', 'setup'],
        queryFn: () => postMfa<T>('setup'),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}
