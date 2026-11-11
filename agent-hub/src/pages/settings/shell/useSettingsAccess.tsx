import { useEntitlements } from '@/components/licensing/EntitlementsContext';
import { useCan } from '@/components/licensing/Gate';
import usePermissionCheck from '@/hooks/usePermissionCheck';
import useProjectsAvailable from '@/hooks/useProjectsAvailable';
import { orgStandingFactsOf } from '@/components/admin/organisation/orgSections';
import type { SettingsUser } from './settingsShellTypes';

// Stable identity for usePermissionCheck (its memo keys on the array reference).
const COMPLIANCE_PERMS = ['admin_compliance'];

/**
 * What this person may see and which deployment they are on: the permission,
 * licence and entitlement facts the settings shell filters its rows on.
 */
export function useSettingsAccess(user: SettingsUser | null | undefined) {
    // Who administers an organisation, the deployment and the Nextcloud facts:
    // one source with the admin dashboard's Organisation tab (orgSections).
    const { canSeeOrg, canManageUsers, isSelfHosted, isNcConnectorUser, isNcOrg, showNcSync, isPlatformAdmin } = orgStandingFactsOf(user);
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
    const isConsumerAccount = !!user?.isConsumerAccount;

    return {
        canSeeOrg, canUseLearning, entitlementsLoading, inCeiling, entitlementsUnknown, projectsOn, canSeeCompliance,
        showComplianceNav, canManageUsers, isSelfHosted, isConsumerAccount, isNcConnectorUser, isNcOrg, showNcSync,
        isPlatformAdmin,
    };
}
