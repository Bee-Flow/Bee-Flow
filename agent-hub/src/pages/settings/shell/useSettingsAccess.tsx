import { useEntitlements } from '@/components/licensing/EntitlementsContext';
import { useCan } from '@/components/licensing/Gate';
import usePermissionCheck from '@/hooks/usePermissionCheck';
import useProjectsAvailable from '@/hooks/useProjectsAvailable';
import type { SettingsUser } from './settingsShellTypes';

// Stable identity for usePermissionCheck (its memo keys on the array reference).
const COMPLIANCE_PERMS = ['admin_compliance'];

/**
 * What this person may see and which deployment they are on: the permission,
 * licence and entitlement facts the settings shell filters its rows on.
 */
export function useSettingsAccess(user: SettingsUser | null | undefined) {
    const perms = user?.permissions || [];
    const canSeeOrg = perms.includes('all') || perms.includes('org_admin') || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
    // Learning Center is toggleable per subscription plan (capability
    // `learning_center`). Hide its nav item + page when the org's plan doesn't
    // include it; the /ai/learning API is gated server-side too.
    const canUseLearning = useCan('learning_center');
    // useCan is also false while the snapshot loads; the bounce below must only
    // fire once the answer is known. `inCeiling` is the org's plan ceiling (not
    // this member's grants), the gate for org-admin rows such as Meeting
    // Templates.
    const {
        loading: entitlementsLoading, inCeiling,
        error: entitlementsError, degraded: entitlementsDegraded,
    } = useEntitlements();
    // A failed or degraded snapshot says nothing about the plan: the rows that
    // hide on an entitlement fail OPEN then, like RequireTier/LockedIfBelow do,
    // rather than taking a page away from everyone during a resolver outage.
    const entitlementsUnknown = !!entitlementsError || !!entitlementsDegraded;
    // Notifications holds only project events (NotificationsSection), so it is
    // offered on the same answer as Projects itself. Like useCan, this reads
    // false while the snapshot loads; its bounce waits for it below.
    const projectsOn = useProjectsAvailable(user);
    // Compliance Center — RBAC (org_admin / dpo / custom roles carrying
    // admin_compliance) AND the enterprise licence capability. The capability is
    // implicitly granted to all members of an enterprise org (non-groupTogglable
    // core cap), so useCan is a precise per-org licence gate. Server-side the
    // /api/compliance mount enforces the same pair.
    const canSeeCompliance = usePermissionCheck(user, COMPLIANCE_PERMS);
    const canUseCompliance = useCan('compliance_hub_gdpr');
    const showComplianceNav = canSeeCompliance && canUseCompliance;
    const canManageUsers = perms.includes('all') || perms.includes('manage_users') || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const isSelfHosted = deploymentMode === 'self-hosted';
    const isConsumerAccount = !!user?.isConsumerAccount;
    // Users coming in through the Nextcloud ExApp connector authenticate via
    // their NC session — the Bee Flow "Sign-in Method" panel (password/SSO/
    // OAuth provider config) doesn't apply because identity is delegated to
    // Nextcloud. Hide that section to avoid the false impression that they
    // can configure auth here. We hide based on org-level binding (ncOrg)
    // rather than the current user's provider so the original creator who
    // bootstrapped the NC org also sees the same gated UI.
    const isNcConnectorUser = user?.provider === 'nextcloud_connector';
    const isNcOrg = !!user?.ncOrg?.instanceId;
    // Super-admins (perms 'all' or role 'admin') manage every org in the
    // deployment, so they should see NC-related sections even if their own
    // session isn't tied to an NC-bound org. Org-admins only see the section
    // when their own org is NC-bound.
    const isSuperAdmin = perms.includes('all') || user?.role === 'admin';
    const showNcSync = isNcOrg || isSuperAdmin;

    return {
        canSeeOrg, canUseLearning, entitlementsLoading, inCeiling, entitlementsUnknown, projectsOn, canSeeCompliance,
        showComplianceNav, canManageUsers, isSelfHosted, isConsumerAccount, isNcConnectorUser, isNcOrg, showNcSync,
    };
}
