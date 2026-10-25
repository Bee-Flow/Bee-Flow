// One remote JSON read for the Solutions screens (useRemote). `authFetch`
// stays inside queryFn: a non-ok answer or a network failure is a STATE the
// caller renders ("could not read"), never an exception.

import { useQuery } from '@tanstack/react-query';
import { authFetch } from '../../utils/helpers';

export async function readJson<T = unknown>(res: Response): Promise<T | null> {
    try { return await res.json(); } catch { return null; }
}

export interface RemoteAnswer<T> {
    ok: boolean;
    body: T | null;
}

export function useRemoteAnswer<T>(url: string | null | undefined, enabled: boolean | undefined) {
    const active = Boolean(enabled && url);
    return useQuery<RemoteAnswer<T>, Error>({
        queryKey: ['studio-remote', url ?? null],
        enabled: active,
        queryFn: async () => {
            try {
                const res = await authFetch(url as string);
                const body = await readJson<T>(res);
                return { ok: res.ok, body: res.ok ? body : null };
            } catch {
                return { ok: false, body: null };
            }
        },
        staleTime: 0,
        retry: false,
    });
}
