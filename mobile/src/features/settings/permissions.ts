/**
 * What may this session be OFFERED?
 *
 * These helpers decide what to render, never what to allow — the server is the
 * only thing that authorises anything, and every gated endpoint here answers
 * 403 on its own. Their job is to keep the app from showing a person a button
 * that is guaranteed to fail, without hiding so much that a legitimate admin
 * cannot find their own tools.
 *
 * The permission ids are the server's, from SYSTEM_PERMISSIONS in
 * server/auth/permissions.js. `all` is the super-permission; `org_admin` is
 * granted to every org-admin role via config/orgRoles.json and reads as "may
 * manage this organisation", not "runs this installation".
 */

import { useAuth } from '../../auth/AuthProvider';

/** Holds at least one of these permissions, or is a platform super-admin. */
export function useHasAnyPermission(...ids: string[]): boolean {
    const { user, permissions } = useAuth();
    if (user?.isAdmin) return true;
    const held = permissions?.permissions ?? [];
    if (held.includes('all')) return true;
    return ids.some((id) => held.includes(id));
}

/**
 * May this session see organisation-administration surfaces?
 *
 * Mirrors the check `GET /auth/users` and `GET /auth/organizations` perform
 * before they will answer at all (auth/admin/userRoutes.js, orgRoutes.js).
 */
export function useIsOrgAdmin(): boolean {
    return useHasAnyPermission('manage_users', 'admin_security', 'org_admin');
}

/**
 * Platform operator — the person who runs the installation, not a customer's
 * administrator. `/api/admin/modules` and the licence health probe are theirs
 * alone, and the server enforces it with requireSuperAdmin.
 */
export function useIsSuperAdmin(): boolean {
    const { user } = useAuth();
    return Boolean(user?.isAdmin || user?.role === 'admin');
}

/** Compliance Hub, DSR administration and the ROPA/audit surfaces. */
export function useCanAdminCompliance(): boolean {
    return useHasAnyPermission('admin_compliance');
}

/** The usage monitoring dashboards beyond plain consumption figures. */
export function useCanAdminMonitoring(): boolean {
    return useHasAnyPermission('admin_monitoring', 'org_admin');
}
