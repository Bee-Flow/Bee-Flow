/**
 * The organisation's groups, for "share with specific groups".
 *
 * `GET /auth/groups` (server/auth/admin/groupRoleRoutes.js) answers the bare
 * array, scoped to the caller's organisations — and 403 for anyone without
 * manage_users / admin_security / org_admin. A refusal or a failure is NOT
 * "this organisation has no groups", so it comes back as `null`, never `[]`,
 * and the sharing sheet says the list could not be read.
 */

import { api } from './client';
import { field, shapeListOf } from './contract';

export interface OrgGroup {
    id: string;
    name: string;
}

const readGroups = shapeListOf({ id: field.str(''), name: field.str('') });

export function readOrgGroups(raw: unknown): OrgGroup[] | null {
    return Array.isArray(raw) ? readGroups(raw).filter((g) => g.id) : null;
}

export async function fetchOrgGroups(signal?: AbortSignal): Promise<OrgGroup[] | null> {
    try {
        return readOrgGroups(await api.get<unknown>('/auth/groups', { signal, retry: false }));
    } catch {
        return null;
    }
}
