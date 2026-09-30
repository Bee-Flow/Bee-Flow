/**
 * Who may do what on the people surface, on the server's terms:
 *   - READ the roster and groups: org admin, or `manage_users`
 *     (GET /auth/users and /auth/groups accept either);
 *   - WRITE a member, invite, and everything under groups, roles, tiers and
 *     access: org admin (requireOrgAdminForUser, isOrgAdminForOrg,
 *     requirePrimaryOrgAdmin, requireOrgAdmin).
 */

import { useHasPermission } from '@/core/access';
import { useOrgContext } from '@/features/org';

export interface PeopleAccess {
    orgId: string | null;
    isOrgAdmin: boolean;
    isNcOrg: boolean;
    canSeePeople: boolean;
}

export function usePeopleAccess(): PeopleAccess {
    const { orgId, isOrgAdmin, isNcOrg } = useOrgContext();
    const manageUsers = useHasPermission('manage_users');
    return { orgId, isOrgAdmin, isNcOrg, canSeePeople: isOrgAdmin || manageUsers };
}
