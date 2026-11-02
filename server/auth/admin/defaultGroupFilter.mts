/**
 * Which of an organisation's stored default groups may be handed to a new
 * member at the moment they join (signup, SSO placement)?
 *
 * The stored list is read as data, never trusted: a default group is applied
 * only when it is the organisation's own group, or a plain global group, one
 * that carries no wildcard or admin permission, no role and no orgRole. That is
 * what a caller without any rights could hand out, so a list written before the
 * write-side check existed grants nothing more than that.
 */

type Group = Record<string, unknown> | null | undefined;

const ADMIN_PERMISSIONS = new Set(['all', 'admin']);

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** True for a global group (no organisation) that grants no admin power. */
export function isPlainGlobalGroup(group: Group): boolean {
    if (!group || group.organizationId) return false;
    if (list(group.permissions).some((p) => ADMIN_PERMISSIONS.has(String(p)))) return false;
    if (list(group.roles).length > 0) return false;
    if (typeof group.orgRole === 'string' && group.orgRole.trim() !== '') return false;
    return true;
}

/** May `group` be applied as a default group of organisation `orgId`? */
export function isApplicableDefaultGroup(group: Group, orgId: string | null | undefined): boolean {
    if (!group) return false;
    if (group.organizationId) return !!orgId && String(group.organizationId) === String(orgId);
    return isPlainGlobalGroup(group);
}

/**
 * The ids of `defaults` that may be applied for `orgId`, in their stored order,
 * without duplicates. An id with no group behind it is dropped.
 */
export function applicableDefaultGroups(defaults: unknown, allGroups: unknown, orgId: string | null | undefined): string[] {
    const groups = list(allGroups) as Group[];
    const out: string[] = [];
    for (const raw of list(defaults)) {
        const gid = String(raw ?? '').trim();
        if (!gid || out.includes(gid)) continue;
        const group = groups.find((g) => g?.id === gid);
        if (isApplicableDefaultGroup(group, orgId)) out.push(gid);
    }
    return out;
}
