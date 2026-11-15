// Does this server have a Nextcloud to look after? The Nextcloud instances row
// of the whole-server block is only worth its place once some organisation is
// bound to a Nextcloud or came in through the Nextcloud connector: the same
// organisation rows (nc_instance_id, registrationSource) its bindings tab lists.
// Asked only for a platform admin who may open that tab. Unknown (loading, a
// failed read) is undefined, which the row's gate reads as yes: the operator's
// rows fail open, as the integration availability does for them.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

/** The organisation fields read here. */
interface OrgRow {
    nc_instance_id?: unknown;
    registrationSource?: unknown;
}

/** Some organisation of the answer is bound to a Nextcloud or was registered by the connector. */
export function hasNextcloudInstancesIn(data: unknown): boolean {
    const rows: unknown = Array.isArray(data) ? data : (data as { organizations?: unknown } | null)?.organizations;
    if (!Array.isArray(rows)) return false;
    return rows.some((row: OrgRow | null) => {
        if (!row || typeof row !== 'object') return false;
        return (typeof row.nc_instance_id === 'string' && row.nc_instance_id !== '') || row.registrationSource === 'nextcloud_connector';
    });
}

/** True or false once the organisations are read; undefined while unknown or not asked. */
export function useHasNextcloudInstances(enabled: boolean): boolean | undefined {
    const query = useQuery<boolean, Error>({
        queryKey: ['admin', 'server-has-nextcloud'] as const,
        enabled,
        queryFn: async () => hasNextcloudInstancesIn(await apiJson<'GET /auth/organizations'>('GET /auth/organizations')),
        staleTime: 60_000,
        retry: false,
    });
    return enabled && query.isSuccess ? query.data : undefined;
}
