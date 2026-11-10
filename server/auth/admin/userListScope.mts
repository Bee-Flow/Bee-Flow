/**
 * Who may read GET /auth/users, and the admin dashboard's variant of the list
 * (`?scope=admin`): the members of the organisation auth/adminOrg.mts
 * resolves for the caller.
 *
 * Built by auth/admin/userRoutes.js with the real collaborators; the route
 * tests (listRoutes.adminScope.test.js) drive it through the router.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../../utils/bestEffort.js') as { fallback: <T>(site: string, err: unknown, value: T) => T };

/** The request fields read here (structural, so no express types are needed). */
export type UserListRequest = {
    session: { isAdmin?: boolean; user?: { id?: string; role?: string; [key: string]: unknown }; [key: string]: unknown };
    query: Record<string, unknown>;
};

export type ListedUser = Record<string, unknown> & { id?: string; organizationId?: unknown; groups?: unknown };
export type ListedGroup = { id: string; organizationId?: string | null };

export type UserListScopeDeps<R extends UserListRequest, U extends ListedUser> = {
    /** auth/permissions getUserPermissions. */
    getUserPermissions: (userId: string | undefined, session: R['session']) => Promise<string[]>;
    /** auth/permissions resolveAdminOrgId: an organisation id, or null (all organisations, platform admins only). Throws HttpError. */
    resolveAdminOrgId: (req: R) => Promise<string | null>;
    getAllUsers: () => Promise<U[]>;
    getAllGroups: () => Promise<ListedGroup[]>;
    /** auth/platformOperator isPlatformOperator: the system row, never listed. */
    isPlatformOperator: (user: U) => boolean;
    /** auth/admin/userSupportRoutes stripKeyMaterial. */
    stripKeyMaterial: (user: U) => unknown;
};

/** The group ids on a user row (an array, or the JSON text of one); none when unreadable. */
function groupIdsOf(user: ListedUser): unknown[] {
    if (Array.isArray(user.groups)) return user.groups;
    try {
        const parsed: unknown = JSON.parse(typeof user.groups === 'string' && user.groups !== '' ? user.groups : '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return fallback<unknown[]>('auth/admin/users:adminScopeGroupsJson', err, []); // no group membership
    }
}

/**
 * The members of one organisation, as the admin dashboard lists them: every
 * user whose home organisation it is, and every user in one of its groups.
 * Never the system row.
 */
export function membersOfOrg<U extends ListedUser>(users: U[], groups: ListedGroup[], orgId: string, isPlatformOperator: (user: U) => boolean): U[] {
    const orgGroupIds = new Set(groups.filter(g => g.organizationId === orgId).map(g => g.id));
    return users.filter(u => {
        if (isPlatformOperator(u)) return false;
        if (u.organizationId === orgId) return true;
        return groupIdsOf(u).some(gid => typeof gid === 'string' && orgGroupIds.has(gid));
    });
}

export function createUserListScope<R extends UserListRequest, U extends ListedUser>(deps: UserListScopeDeps<R, U>) {
    /**
     * Whether the caller may list users at all: a platform admin, or anyone
     * holding manage_users, admin_security, org_admin or 'all'.
     */
    async function mayViewUsers(req: R): Promise<boolean> {
        if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
        const perms = await deps.getUserPermissions(req.session.user?.id, req.session);
        return ['all', 'manage_users', 'admin_security', 'org_admin'].some(p => perms.includes(p));
    }

    /**
     * The admin dashboard's list (`?scope=admin`). Null when the request is not
     * admin-scoped, or when a platform admin has not named an organisation
     * (the full list, as without the parameter). Throws the resolver's
     * HttpError (403 for anyone who is not an admin of their home organisation).
     */
    async function adminScopedUsers(req: R): Promise<unknown[] | null> {
        if (req.query.scope !== 'admin') return null;
        const adminOrgId = await deps.resolveAdminOrgId(req);
        if (adminOrgId === null) return null;
        const [users, groups] = await Promise.all([deps.getAllUsers(), deps.getAllGroups()]);
        return membersOfOrg(users, groups, adminOrgId, deps.isPlatformOperator).map(deps.stripKeyMaterial);
    }

    return { mayViewUsers, adminScopedUsers };
}
