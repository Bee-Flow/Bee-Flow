// The organisations the admin dashboard's organisation picker lists: GET
// /auth/organizations?scope=admin, which gives a platform admin every
// organisation on the server. Only the id and the name are read.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { readOrNull } from './refusableRead';

/** One organisation of the picker. */
export interface AdminOrgOption {
    id: string;
    name: string;
}

/** The rows of the answer as picker options; a row without an id is dropped, a row without a name shows its id. */
function toOptions(data: unknown): AdminOrgOption[] {
    const rows: unknown = Array.isArray(data) ? data : (data as { organizations?: unknown } | null)?.organizations;
    if (!Array.isArray(rows)) return [];
    const options: AdminOrgOption[] = [];
    for (const row of rows as { id?: unknown; name?: unknown }[]) {
        if (typeof row?.id !== 'string' || row.id === '') continue;
        options.push({ id: row.id, name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id });
    }
    return options;
}

/** The picker's organisations, asked only when `enabled` (a platform admin); a refusal reads as none. */
export function useAdminOrganizationsQuery(enabled: boolean) {
    return useQuery<AdminOrgOption[], Error>({
        queryKey: ['admin', 'org-picker'] as const,
        enabled,
        queryFn: async ({ signal }) => toOptions(await readOrNull<unknown>(`${API_BASE}/auth/organizations?scope=admin`, signal)),
        staleTime: 60_000,
        retry: false,
    });
}
