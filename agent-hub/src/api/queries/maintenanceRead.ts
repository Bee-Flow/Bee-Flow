// GET /api/maintenance: the announced deployment window and the build the
// server runs. Polled gently while nothing is announced, every few seconds
// while a window is open (useMaintenanceWindow says why). A refused read (401
// on a logged-out tab) or a failed one during a rollout keeps the last answer.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export interface MaintenanceAnswer<W> {
    appVersion?: string;
    maintenance?: W | null;
}

export function useMaintenanceQuery<W>({ enabled, idleMs, activeMs }: { enabled: boolean; idleMs: number; activeMs: number }) {
    return useQuery<MaintenanceAnswer<W>, Error>({
        queryKey: ['maintenance'],
        enabled,
        ...READ_ONCE,
        refetchInterval: (query) => (query.state.data?.maintenance ? activeMs : idleMs),
        refetchIntervalInBackground: true,
        queryFn: () => apiJson<'GET /api/maintenance', MaintenanceAnswer<W>>('GET /api/maintenance'),
    });
}
