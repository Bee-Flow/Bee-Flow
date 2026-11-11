// The facts the Organisation tab's section rules read (orgSections), for the
// organisation the tab works on. `enabled` false (a viewer without the tab) asks
// the server nothing.

import { useGithubStatusQuery, useSettingsOrganizationsQuery } from '@/api/queries/shellReads';
import { useEntitlements } from '@/components/licensing/EntitlementsContext';
import { useCan } from '@/components/licensing/Gate';
import { orgStandingFactsOf, type OrgFactsUser, type OrgSectionFacts } from './orgSections';

export function useOrgSectionFacts(user: OrgFactsUser | null | undefined, orgId: string | null, enabled = true): OrgSectionFacts {
    const standing = orgStandingFactsOf(user);
    const canUseLearning = useCan('learning_center');
    const { loading: entitlementsLoading, inCeiling, error, degraded } = useEntitlements();
    // GitHub Sync is offered once the viewer connected a GitHub account in Settings → Connections.
    const githubConnected = !!useGithubStatusQuery<{ connected?: boolean }>(enabled).data?.connected;
    // The sign-in method of THIS organisation: it locks once saved.
    const orgs = useSettingsOrganizationsQuery<{ id?: string; authMethod?: string | null }>(enabled && !!orgId).data;
    const orgAuthLocked = !!orgId && Array.isArray(orgs) && !!orgs.find(o => o.id === orgId)?.authMethod;
    return {
        ...standing,
        canUseLearning,
        githubConnected,
        orgAuthLocked,
        entitlementsLoading,
        // A failed or degraded snapshot says nothing about the plan: rows fail open.
        entitlementsUnknown: !!error || !!degraded,
        inCeiling,
    };
}
