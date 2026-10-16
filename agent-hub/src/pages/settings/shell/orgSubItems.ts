import type { OrgSubItem } from './settingsShellTypes';

/** The facts the organisation sub-menu is filtered on. */
export interface OrgSubItemFacts {
    canSeeOrg: boolean;
    canManageUsers: boolean;
    canUseLearning: boolean;
    showComplianceNav: boolean;
    isSelfHosted: boolean;
    isNcConnectorUser: boolean;
    isNcOrg: boolean;
    showNcSync: boolean;
    githubConnected: boolean;
    orgAuthLocked: boolean;
    entitlementsLoading: boolean;
    entitlementsUnknown: boolean;
    inCeiling?: (id: string) => boolean;
}

/** The org sub-menu rows this person gets, from the full list plus the self-hosted Azure row. */
export function filterOrgSubItems(baseItems: OrgSubItem[], azureItem: OrgSubItem, {
    canSeeOrg, canManageUsers, canUseLearning, showComplianceNav, isSelfHosted, isNcConnectorUser, isNcOrg, showNcSync,
    githubConnected, orgAuthLocked, entitlementsLoading, entitlementsUnknown, inCeiling,
}: OrgSubItemFacts): OrgSubItem[] {
    const items = baseItems.filter(s => {
        // Non-org-admins see only the entries their own permission grants:
        // Compliance for pure-DPO users.
        if (!canSeeOrg && s.id !== 'org_compliance') return false;
        // Hidden below Enterprise (deep links still land on UpgradePrompt).
        if (s.id === 'org_compliance') return showComplianceNav;
        // Self-hosted: licensing is governed server-wide from the admin
        // dashboard ("Server licence"), not per-org. Drop the per-org
        // "License & Usage" entry entirely.
        if (s.id === 'license' && isSelfHosted) return false;
        if (s.id === 'org_users') return canManageUsers;
        // Academy overview only makes sense when the plan carries the
        // Learning Center at all (entitlements-gated like the member tab).
        if (s.id === 'org_academy') return canSeeOrg && canUseLearning;
        // Always show Integrations to org admins — the page (who gets which
        // integration, and the integrations' own settings) has empty
        // states for orgs without grants.
        if (s.id === 'org_integrations') return canSeeOrg;
        if (s.id === 'org_mcp') return canSeeOrg;
        if (s.id === 'org_mcp_access') return canSeeOrg;
        // Meeting Templates (and the Meet / Teams meeting-notes panels on
        // the same page) is behind the meeting_notes licence on the
        // server, so without it the page is empty. The org's plan ceiling,
        // not this admin's own grants: a group rollout must not hide it.
        // Not drawn while the snapshot loads; the deep link still renders.
        if (s.id === 'org_meeting_templates') return canSeeOrg && !entitlementsLoading && (entitlementsUnknown || !!inCeiling?.('meeting_notes'));
        // NC-bound orgs: auth is delegated to Nextcloud entirely. The
        // Sign-in Method panel configures username/password + OAuth
        // providers which are no-ops once identity comes from NC, so
        // hide it for everyone — including super-admins.
        if ((isNcOrg || isNcConnectorUser) && s.id === 'auth') return false;
        // Sign-in method is a one-time, locked choice. Once the org has
        // picked one, the cloud panel only shows a "locked" notice with no
        // editable controls — drop the sidebar entry so admins aren't
        // pointed at a dead-end page. Self-hosted keeps it: the same page
        // hosts the Allowed Domains editor, which stays editable after
        // the lock.
        if (orgAuthLocked && s.id === 'auth' && !isSelfHosted) return false;
        // Nextcloud Sync — visible when the user's own org is NC-bound,
        // OR when the user is a super-admin who could be managing NC orgs.
        if (s.id === 'org_nextcloud_sync' && !showNcSync) return false;
        // GitHub Sync only matters once a GitHub account is connected in
        // Settings → Connections. Hide the menu item until then so admins
        // aren't dropped on a "Not connected" stub.
        if (s.id === 'org_github_sync' && !githubConnected) return false;

        return true;
    });
    // Azure services config — self-hosted operator surface for org admins.
    if (isSelfHosted && canSeeOrg) {
        items.push(azureItem);
    }
    return items;
}

/** The rows as the sidebar draws them: the groups' order, empty groups dropped, unfiled rows in a group of their own at the end. */
export function groupOrgNavItems(orgSubItems: OrgSubItem[], groups: string[][]): OrgSubItem[][] {
    const byId = new Map(orgSubItems.map(s => [s.id, s]));
    const filed = new Set(groups.flat());
    return [
        ...groups.map(ids => ids.map(id => byId.get(id)).filter((s): s is OrgSubItem => s !== undefined)),
        orgSubItems.filter(s => !filed.has(s.id)),
    ].filter(g => g.length > 0);
}
