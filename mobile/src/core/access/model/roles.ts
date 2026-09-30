/**
 * Who is this person: super admin, org admin, holder of a permission.
 *
 * These decide what to OFFER, never what to allow — the server authorises
 * every call on its own. Their job is to keep a button that is guaranteed to
 * 403 off the screen, without hiding a legitimate admin's own tools.
 *
 * Permission ids are the server's (SYSTEM_PERMISSIONS in
 * server/auth/permissions.js). `all` is the super-permission, and the server
 * hands it to every super admin (getUserPermissions answers ['all'] for an
 * admin session), so every check below honours it.
 */

/** The permission that stands for every other one. */
export const ALL_PERMISSIONS = 'all';

/**
 * The org roles the server's requireOrgAdmin accepts: ORG_ADMIN_VARIANTS in
 * server/auth/permissions.js ('org_admin', plus the pre-rename 'admin').
 */
export const ORG_ADMIN_ROLES: readonly string[] = ['org_admin', 'admin'];

/** The permission config/orgRoles.json grants every org-admin role. */
export const ORG_ADMIN_PERMISSION = 'org_admin';

export interface PersonFacts {
    isAdmin?: boolean;
    role?: string;
    orgRole?: string;
    permissions: readonly string[];
}

/**
 * The platform operator — who runs the installation, not a customer's
 * administrator. The server's isSuperAdmin(req): `session.isAdmin ||
 * user.role === 'admin'`; /auth/user reports the first as `isAdmin`.
 * Holding `all` is deliberately NOT enough (requireSuperAdmin).
 */
export function isSuperAdmin(person: Pick<PersonFacts, 'isAdmin' | 'role'>): boolean {
    return Boolean(person.isAdmin || person.role === 'admin');
}

/**
 * Holds `id`, or `all`, or is a super admin. The web's hasPermission
 * (`perms.includes('all') || perms.includes(perm)`), plus the super-admin
 * pass that covers the moment before /auth/my-permissions has answered.
 */
export function hasPermission(person: PersonFacts, id: string): boolean {
    if (isSuperAdmin(person)) return true;
    return person.permissions.includes(ALL_PERMISSIONS) || person.permissions.includes(id);
}

/** Holds at least one of `ids` (see hasPermission). No ids means no. */
export function hasAnyPermission(person: PersonFacts, ids: readonly string[]): boolean {
    return ids.some((id) => hasPermission(person, id));
}

/**
 * May this person use the organisation-administration surfaces?
 *
 * Matches what the server's org-admin WRITE gates accept (requireOrgAdmin,
 * requirePrimaryOrgAdmin, isOrgAdminForOrg): a super admin, or an orgRole in
 * ORG_ADMIN_ROLES — plus the `org_admin` permission, which orgRoles.json gives
 * every org-admin role and which a group can grant directly, and `all`, which
 * isOrgAdminForOrg accepts from a group of the org.
 *
 * NOT `manage_users` or `admin_security` on their own. The phone used to
 * accept those, so a custom role holding only `manage_users` was shown
 * organisation surfaces whose every write answered 403 (the "Mismatch" in the
 * org-admin parity report). Those permissions still gate what they name, via
 * hasPermission.
 */
export function isOrgAdmin(person: PersonFacts): boolean {
    if (isSuperAdmin(person)) return true;
    if (person.orgRole && ORG_ADMIN_ROLES.includes(person.orgRole)) return true;
    return hasPermission(person, ORG_ADMIN_PERMISSION);
}

export interface CanUseFacts {
    permissions: readonly string[];
    betaFeatures: readonly string[];
    canUseFeature: Readonly<Record<string, boolean>>;
}

/**
 * The web's makeCanUse (studioApps.jsx): the server-resolved canUseFeature
 * map (licence × beta) is authoritative when it names the feature — `??`, so
 * an explicit false beats a stale `all` — otherwise `all` or the beta list.
 */
export function canUseFeature(facts: CanUseFacts, id: string): boolean {
    const answer = facts.canUseFeature[id];
    if (typeof answer === 'boolean') return answer;
    return facts.permissions.includes(ALL_PERMISSIONS) || facts.betaFeatures.includes(id);
}
