// The facts the Organisation tab's section rules read (orgSections), for the
// organisation the tab works on: the viewer's standing from their account, and
// what the CHOSEN organisation has from its integration availability (one read
// per organisation, shared by the rail and the tab). `enabled` false (a viewer
// without the tab) asks the server nothing.

import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { homeOrgIdOf } from '@/utils/adminAccess';
import { orgAvailabilityFactsOf, orgStandingFactsOf, type OrgFactsUser, type OrgSectionFacts } from './orgSections';

export function useOrgSectionFacts(user: (OrgFactsUser & Readonly<Record<string, unknown>>) | null | undefined, orgId: string | null, enabled = true): OrgSectionFacts {
    const { canSeeOrg, canManageKnowledge, isSelfHosted, isNcConnectorUser, isNcOrg, isPlatformAdmin } = orgStandingFactsOf(user);
    const read = useOrgIntegrationAvailability(orgId, enabled);
    const availability = orgAvailabilityFactsOf({
        read,
        platformAdmin: isPlatformAdmin,
        homeOrg: !!orgId && orgId === homeOrgIdOf(user),
        sessionNcBound: isNcOrg,
    });
    // isLoading, not isPending: a read that is off (no organisation) is pending for good.
    return { canSeeOrg, canManageKnowledge, isSelfHosted, isNcConnectorUser, isPlatformAdmin, ...availability, availabilityPending: read.isLoading };
}
