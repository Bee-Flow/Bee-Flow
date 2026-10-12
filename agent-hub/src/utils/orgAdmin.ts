// Whether a signed-in user administers their organisation (or the whole
// instance). One predicate for the sidebar and the project workspace; the
// server stays the judge of what an admin may actually do.

export interface OrgAdminUserLike {
    isAdmin?: boolean;
    orgRole?: string | null;
    permissions?: string[] | null;
}

export function isOrgAdminLike(user: OrgAdminUserLike | null | undefined): boolean {
    return !!(user?.isAdmin || user?.orgRole === 'admin' || user?.orgRole === 'org_admin'
        || (user?.permissions || []).includes('all'));
}
