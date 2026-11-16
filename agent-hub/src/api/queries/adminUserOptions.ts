// The accounts a platform admin picks from (the Microsoft identity link, the
// identity unlink): GET /auth/users?scope=admin, which gives a platform admin
// every account on the server. Only the id, the name and the e-mail address
// are read; a refusal reads as none, so the caller falls back to a typed id.

import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/api/typedRequest';
import { readOrNull } from './refusableRead';

/** One account of the picker. */
export interface AdminUserOption {
    id: string;
    /** The display name, else the e-mail address, else the id. */
    name: string;
    email: string;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * The rows of the answer as picker options, sorted by name. A row without an
 * id is dropped, and so is the server's built-in system row (`isSystem`, the
 * first row of the unscoped list): no Microsoft identity can belong to it.
 */
export function toUserOptions(data: unknown): AdminUserOption[] {
    if (!Array.isArray(data)) return [];
    const options: AdminUserOption[] = [];
    for (const row of data as Record<string, unknown>[]) {
        const id = str(row?.id);
        if (id === '' || row.isSystem === true) continue;
        const email = str(row.email);
        const name = str(row.displayName) || [str(row.firstName), str(row.lastName)].filter(Boolean).join(' ') || email || id;
        options.push({ id, name, email });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** The picker's accounts, asked only when `enabled`. */
export function useAdminUserOptionsQuery(enabled = true) {
    return useQuery<AdminUserOption[], Error>({
        queryKey: ['admin', 'user-picker'] as const,
        enabled,
        queryFn: async ({ signal }) => toUserOptions(await readOrNull<unknown>(`${apiUrl('GET /auth/users')}?scope=admin`, signal)),
        staleTime: 60_000,
        retry: false,
    });
}
