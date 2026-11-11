import type { OrgRolePermissions } from '../useOrgDirectory';

/** The member as far as the role-editing rule reads them. */
interface RoleEditor {
    isAdmin?: boolean;
    orgRole?: string | null;
}

/**
 * Only an org admin may reshape what a role grants: the server refuses the
 * PUT for anyone else, so offering the toggles would be a lie.
 */
export function canUserEditRoles(user: RoleEditor | null | undefined): boolean {
    return !!(user?.isAdmin || ['org_admin', 'admin'].includes(user?.orgRole ?? ''));
}

/**
 * Splice one saved role back into the mapping so the chips above the editor
 * update without re-fetching the whole panel. The server returns only the
 * editable half; everything else the role carries is untouched by the save.
 */
export function spliceRolePermissions(prev: OrgRolePermissions[], roleId: string, permissions: string[], editable: string[]): OrgRolePermissions[] {
    return prev.map(r => (r.id === roleId
        ? { id: r.id, permissions: [...r.permissions.filter(p => !editable.includes(p)), ...permissions] }
        : r));
}
