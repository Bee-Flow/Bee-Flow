import { useApprovalsNav as useApprovalsNavJs } from './useApprovalsNav';
import { useStudioSectionData as useStudioSectionDataJs } from './useStudioSectionData';
import type { PublishedApp, PublishedForm, StudioSection } from './sidebarNav';
import type { StudioCounts } from '../../../hooks/useStudioCounts';
import { isOrgAdminLike as isOrgAdminUser } from '../../../utils/orgAdmin';
import { STUDIO_APPS } from '../../admin/Studio/studioApps';
import { canSeeStudio as canSeeStudioFor, studioGateContext, studioNavSections } from '../../admin/Studio/studioNav';
import { useEntitlements as useEntitlementsJs } from '../../licensing/EntitlementsContext';
import { useLicenseContext as useLicenseContextJs } from '../../licensing/LicenseContext';

type Check = (id: string) => boolean;
type LockReason = (id: string) => string | null;

interface SidebarUser {
    permissions?: string[];
    simpleMode?: boolean;
    [key: string]: unknown;
}

// The licence and entitlement contexts are JavaScript; this is what the sidebar reads of them.
const useLicenseContext = useLicenseContextJs as () => { hasFeature: Check; deploymentMode?: string };
const useEntitlements = useEntitlementsJs as () => {
    can: Check; lockReason?: LockReason | null; loading?: boolean; error?: unknown;
};
const useApprovalsNav = useApprovalsNavJs as (opts: { canBrowseApprovals: boolean; isOrgAdmin: boolean }) => {
    pendingCount?: number; hasApprovals: boolean;
};
const useStudioSectionData = useStudioSectionDataJs as (opts: {
    currentPage?: string; canUseCapability: Check; hasLicenseFeature: Check; user: unknown; countsEnabled: boolean;
}) => {
    runtimeStudioApps: StudioSection[];
    publishedApps: PublishedApp[]; hasApps: boolean;
    canSeeForms: boolean; publishedForms: PublishedForm[]; hasForms: boolean;
    loadSectionItems: unknown; recentItemsFor: unknown;
    studioCounts: StudioCounts | null;
};

/**
 * What this person may see in the sidebar: the licence, the entitlements and
 * permissions behind the Studio rows, the published apps and forms, and the
 * approvals they handle. Split out of Sidebar.jsx without a change in
 * behaviour.
 */
export function useSidebarAccess({ user, isMobile, currentPage, hasPermissionProp }: {
    user: SidebarUser | null | undefined;
    isMobile: boolean;
    currentPage?: string;
    hasPermissionProp?: Check | null;
}) {
    const { hasFeature: hasLicenseFeature, deploymentMode } = useLicenseContext();
    // Effective-permission check for the Studio section gates. AgentHub passes
    // the real resolver; fall back to a permissions spot-check so the sidebar
    // renders sanely if a caller omits it.
    const hasPermission: Check = hasPermissionProp || ((perm) => {
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    });
    // `lockReason` decides hide-vs-lock for the Studio rows. While the
    // entitlements are still LOADING (every page load) or their fetch FAILED,
    // `can` answers false for everything and lockReason would call each gated
    // section 'ceiling' — so a licensed org watched its sections flash
    // "Available on a higher plan" on every load. A row is only locked once
    // the answer is real; until then the failed gate hides the row.
    const {
        can: canUseCapability, lockReason: entitlementLockReason,
        loading: entitlementsLoading, error: entitlementsError,
    } = useEntitlements();
    const lockReason: LockReason = (entitlementsLoading || entitlementsError || !entitlementLockReason)
        ? () => null
        : entitlementLockReason;

    // Gate context + the resolved rows come from studioNav.js, shared with the
    // Studio rail, the Start screen and the shell's direct-URL guard so they
    // cannot answer the gate question differently.
    const gateCtx = studioGateContext({ user, hasLicenseFeature, hasPermission, can: canUseCapability, lockReason });

    // Who gets Studio at all: a builder, or anyone for whom at least one
    // section passes its own gate (studioNav.canSeeStudio). Simple Mode and
    // phones run the simplified surface. Decided here on the built-in
    // sections, before the hook below, so the counts poll stays off for
    // everyone without Studio; the final answer adds the runtime modules.
    const studioSurface = !user?.simpleMode && !isMobile;
    const studioCountsEnabled = studioSurface
        && canSeeStudioFor({ user, sections: studioNavSections(STUDIO_APPS, gateCtx) });

    // Published apps/forms + per-Studio-section recent items + counts for the flyouts.
    const data = useStudioSectionData({ currentPage, canUseCapability, hasLicenseFeature, user, countsEnabled: studioCountsEnabled });

    // The registry descriptors carry the nav fields (urlSegment, Icon, …) the gate type leaves out.
    const studioSections = studioNavSections([...STUDIO_APPS, ...data.runtimeStudioApps], gateCtx) as unknown as StudioSection[];
    const canSeeStudio = studioSurface && canSeeStudioFor({ user, sections: studioSections });

    // "Waiting on you" — how many approvals this person can decide right now
    // (the badge), and whether the Approvals row belongs in the menu at all.
    // LICENCE: /approvals/facets is a gated route, so polling it without
    // `approvals` would only collect 403s. ROLE: `use_approvals` says this
    // person handles them. Deliberately NOT the Studio/builder gate: an
    // assignee is often exactly the person with no builder rights.
    const canBrowseApprovals = hasLicenseFeature('approvals') && hasPermission('use_approvals');
    const { pendingCount: pendingApprovalCount, hasApprovals } = useApprovalsNav({
        canBrowseApprovals,
        isOrgAdmin: isOrgAdminUser(user),
    });

    return {
        hasLicenseFeature, deploymentMode, hasPermission, canUseCapability,
        studioSections, canSeeStudio, data,
        canBrowseApprovals, pendingApprovalCount, hasApprovals,
    };
}
