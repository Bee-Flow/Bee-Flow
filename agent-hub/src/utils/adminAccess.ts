// Who the SPA treats as an administrator, in one place.
//
// Two different questions, answered the way the server answers them:
//   isPlatformAdmin   the operator of the whole server (server: isSuperAdmin,
//                     `requireSuperAdmin`): the session flag or users.role
//                     'admin'. The 'all' permission does NOT count: it is
//                     reachable inside one organisation through a role on a
//                     group, so it is not a server-wide layer.
//   isOrgAdminRole    an organisation role that administers its own
//                     organisation (server: permissionsCatalog.isOrgAdminRole).
//                     Mirrored, pinned by adminAccess.lockstep.test.js.

/** The user fields the admin checks read. */
export interface AdminAccessUser {
    isAdmin?: boolean | null;
    role?: string | null;
    orgRole?: string | null;
}

/** The organisation roles that administer their organisation: the current name and the legacy one. */
const ORG_ADMIN_ROLES: readonly string[] = ['org_admin', 'admin'];

/** Is this viewer the operator of the whole server? The 'all' permission does not make anyone one. */
export function isPlatformAdmin(user: AdminAccessUser | null | undefined): boolean {
    return !!user && (user.isAdmin === true || user.role === 'admin');
}

/** Does this organisation role administer its own organisation? */
export function isOrgAdminRole(orgRole: string | null | undefined): boolean {
    return typeof orgRole === 'string' && ORG_ADMIN_ROLES.includes(orgRole);
}

/** The id of the viewer's home organisation, or null when the account has none. */
export function homeOrgIdOf(user: Readonly<Record<string, unknown>> | null | undefined): string | null {
    const id = user?.organizationId ?? user?.orgId;
    return typeof id === 'string' && id !== '' ? id : null;
}

/** The account fields mayManageAccount reads. */
export interface ManagedAccount {
    role?: string | null;
    organizationId?: string | null;
}

/**
 * May this viewer edit, reset, delete or regroup this account? The server
 * (requireOrgAdminForUser) decides on the account's HOME organisation and keeps
 * a platform admin's account to platform admins. In the admin screens anyone
 * but a platform admin acts on their own home organisation, so an account that
 * is in it only through a group, or that has no home organisation, is listed
 * read-only.
 */
export function mayManageAccount(account: ManagedAccount, viewerIsPlatformAdmin: boolean, viewerHomeOrgId: string | null): boolean {
    if (viewerIsPlatformAdmin) return true;
    if (account.role === 'admin') return false;
    return viewerHomeOrgId !== null && account.organizationId === viewerHomeOrgId;
}

/**
 * Does this viewer administer their HOME organisation? The server answers it in
 * /auth/my-permissions (`isHomeOrgAdmin`, permissionsOrgGates._evalOrgAdmin: an
 * admin orgRole there, or a group of it that carries admin rights), the check
 * its org-admin routes make. Without that answer the viewer is not counted.
 */
export function isHomeOrgAdmin(user: Readonly<Record<string, unknown>> | null | undefined): boolean {
    return user?.isHomeOrgAdmin === true;
}
