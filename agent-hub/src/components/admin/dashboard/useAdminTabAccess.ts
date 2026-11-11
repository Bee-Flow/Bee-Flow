// Which dashboard tabs a viewer may open, in one place: the dashboard itself and
// the way in (the profile menu's dashboard link) ask the same question, so the
// link shows exactly when at least one tab would open.

import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { resolveAgentSection } from '@/components/agents/agentSections';
import { isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';
import { ADMIN_TABS, canOpenAdminTab, type AdminTab } from './adminTabs';

/** The user fields the tab gates read. */
export interface AdminTabUser {
    isAdmin?: boolean | null;
    role?: string | null;
    orgRole?: string | null;
    permissions?: string[] | null;
    allowedAgentTypes?: string[];
}

/**
 * The permission test of the dashboard. A platform admin holds every one; anyone
 * else what their permission list says, and `org_admin` also by an organisation
 * role that administers the organisation (the test Settings > Organisation used,
 * useSettingsAccess canSeeOrg), so an organisation admin by role opens the
 * Organisation tab.
 */
function adminPermissionCheck(user: AdminTabUser | null | undefined): (perm: string) => boolean {
    if (isPlatformAdmin(user)) return () => true;
    const perms = user?.permissions || [];
    const orgAdminByRole = isOrgAdminRole(user?.orgRole);
    return (perm) => perms.includes('all') || perms.includes(perm) || (perm === 'org_admin' && orgAdminByRole);
}

export interface AdminTabAccessResult {
    hasPermission: (perm: string) => boolean;
    /** Platform admin: users.role 'admin' or the session flag, never the 'all' permission. */
    isSuperAdmin: boolean;
    checkTabAccess: (tab: AdminTab | undefined) => boolean;
    /** At least one tab opens (or the viewer is a platform admin / holds 'all'). */
    canOpenDashboard: boolean;
}

/** The tab gates for this viewer on this install (deployment mode, licence tier). */
export function useAdminTabAccess(user: AdminTabUser | null | undefined): AdminTabAccessResult {
    const { isCloud, isSelfHosted } = useDeploymentMode();
    const { serverOverride, tier } = useLicenseContext();
    const isSuperAdmin = isPlatformAdmin(user);
    const hasPermission = adminPermissionCheck(user);
    // The Agents tab with no section left for this viewer would open an empty hub.
    const hasAgentSection = resolveAgentSection(user ? { ...user, isAdmin: user.isAdmin ?? undefined, role: user.role ?? undefined } : user, '').visible.length > 0;
    const checkTabAccess = (tab: AdminTab | undefined) => canOpenAdminTab(tab, {
        isCloud, isSelfHosted, tier, serverOverride: !!serverOverride, isSuperAdmin, hasPermission,
    }) && !(tab?.id === 'agents' && !hasAgentSection);
    const canOpenDashboard = isSuperAdmin || hasPermission('all') || ADMIN_TABS.some(tab => checkTabAccess(tab));
    return { hasPermission, isSuperAdmin, checkTabAccess, canOpenDashboard };
}
