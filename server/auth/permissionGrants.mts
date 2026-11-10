/**
 * Which organisation each of a user's permissions holds in.
 *
 * getUserPermissions (auth/permissionsResolve.js) answers "what may this user
 * do" as one flat set over every group and organisation. That is the right
 * answer for a page or a feature, and the wrong one for a resource that lives
 * in one organisation: a right earned in organisation A says nothing about an
 * agent of organisation B the user merely reaches through a group.
 *
 * This module collects the same sources as a list of grants, each tagged with
 * the organisation it holds in. getUserPermissions builds its flat set as the
 * union of these grants, in the order they are collected, so the flat answer
 * and the per-organisation answer come from one derivation.
 *
 * Where each source holds:
 *   - a group's permissions, the permissions its capability grants imply and
 *     the permissions of its roles: the group's organisation, or the user's
 *     home organisation for a group without one;
 *   - the user's direct role (users.role other than 'admin'): the home
 *     organisation;
 *   - the user's orgRole and the organisation-wide "All members" grants: the
 *     home organisation;
 *   - a group's orgRole: the group's organisation, or the home organisation
 *     for a group without one.
 * A grant with no organisation at all (a group without one and no home
 * organisation) holds in no organisation. The 'all' permission inside a grant
 * stands for every permission, in that grant's organisation only.
 *
 * Pure: every store read comes in through `GrantSources`, and the calls into it
 * happen in a fixed order (the order getUserPermissions has always read them).
 */

/** The user row fields the grants read. */
export interface GrantUser {
    role?: unknown;
    orgRole?: unknown;
    organizationId?: unknown;
}

/** The group row fields the grants read. */
export interface GrantGroup {
    id?: unknown;
    organizationId?: unknown;
    permissions?: unknown;
    granted_capabilities?: unknown;
    roles?: unknown;
    orgRole?: unknown;
}

/** The role row fields the grants read. */
export interface GrantRole {
    id?: unknown;
    permissions?: unknown;
}

export interface GrantSources {
    /** The user's group ids, in the user's own order. */
    groupIds: readonly unknown[];
    allGroups: readonly (GrantGroup | null | undefined)[];
    allRoles: readonly (GrantRole | null | undefined)[];
    /** Capability id -> the permissions a grant of it to a group implies. */
    impliedByCapability: Readonly<Record<string, readonly string[]>>;
    /** Maps a legacy orgRole spelling onto the current one; null for no role. */
    normaliseOrgRole(role: unknown): string | null;
    /** The permissions `role` carries in organisation `orgId` (its Roles screen over the defaults), or null. */
    permsForRoleInOrg(role: string, orgId: unknown): Promise<readonly string[] | null>;
    /** The home organisation's "All members" grants for a user with `orgRole` (empty when its Roles screen decided that role). */
    orgWideGrants(orgId: unknown, orgRole: string | null): Promise<readonly string[]>;
}

/** Permissions that hold in one organisation (`orgId` null: in none). */
export interface PermissionGrant {
    orgId: string | null;
    permissions: string[];
}

function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Organisation key of a row value. Truthiness, as orgScope reads it: an
 * org-less account stores the empty string.
 */
function orgKey(v: unknown): string | null {
    return (typeof v === 'string' || typeof v === 'number') && v !== '' ? String(v) : null;
}

/**
 * Every grant the user holds, in collection order. `user.role === 'admin'` is
 * not handled here: the caller answers a platform admin before it asks.
 */
export async function collectPermissionGrants(user: GrantUser, sources: GrantSources): Promise<PermissionGrant[]> {
    const homeOrgId = orgKey(user.organizationId);
    const roleById = new Map<unknown, GrantRole>();
    for (const r of sources.allRoles) if (r) roleById.set(r.id, r);
    const groupOf = (gid: unknown): GrantGroup | undefined => sources.allGroups.find((g) => !!g && g.id === gid) || undefined;

    const grants: PermissionGrant[] = [];
    const add = (orgId: string | null, permissions: readonly string[] | null | undefined) => {
        const list = strings(permissions);
        if (list.length > 0) grants.push({ orgId, permissions: list });
    };

    // A group's own permissions, what its capability grants imply, and its roles.
    for (const gid of sources.groupIds) {
        const group = groupOf(gid);
        if (!group) continue;
        const perms = [...strings(group.permissions)];
        for (const capId of strings(group.granted_capabilities)) {
            perms.push(...(sources.impliedByCapability[capId] || []));
        }
        for (const rid of Array.isArray(group.roles) ? group.roles : []) {
            perms.push(...strings(roleById.get(rid)?.permissions));
        }
        add(orgKey(group.organizationId) ?? homeOrgId, perms);
    }

    // The user's direct role (for example 'admin-light').
    if (user.role && user.role !== 'admin') {
        add(homeOrgId, strings(roleById.get(user.role)?.permissions));
    }

    // The user's orgRole, in the home organisation.
    const userOrgRole = sources.normaliseOrgRole(user.orgRole);
    if (userOrgRole) add(homeOrgId, await sources.permsForRoleInOrg(userOrgRole, user.organizationId));

    // The home organisation's "All members" grants.
    if (user.organizationId) add(homeOrgId, await sources.orgWideGrants(user.organizationId, userOrgRole));

    // A group's orgRole, in the group's organisation.
    for (const gid of sources.groupIds) {
        const group = groupOf(gid);
        const groupOrgRole = sources.normaliseOrgRole(group?.orgRole);
        if (!groupOrgRole) continue;
        add(orgKey(group?.organizationId) ?? homeOrgId,
            await sources.permsForRoleInOrg(groupOrgRole, group?.organizationId || user.organizationId));
    }

    return grants;
}

/** The flat union of the grants, in collection order, without duplicates. */
export function permissionsOfGrants(grants: readonly PermissionGrant[]): string[] {
    const set = new Set<string>();
    for (const g of grants) for (const p of g.permissions) set.add(p);
    return [...set];
}

/**
 * Do the grants hold `permission` (or 'all') in organisation `orgId`? Never
 * for an absent organisation: a grant without one holds nowhere.
 */
export function grantsHoldInOrg(grants: readonly PermissionGrant[], permission: string, orgId: unknown): boolean {
    const key = orgKey(orgId);
    if (!key) return false;
    return grants.some((g) => g.orgId === key && (g.permissions.includes(permission) || g.permissions.includes('all')));
}
