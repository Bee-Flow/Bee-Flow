// The organisation an organisation page works on (contract for every package
// that renders one in the dashboard):
//   inside the dashboard   a platform admin: the organisation chosen in the
//                          scope bar, or `needsChoice` while "All
//                          organisations" is chosen; anyone else: their home
//                          organisation;
//   outside the dashboard  (no AdminOrgProvider) the home organisation.

import { homeOrgIdOf } from '@/utils/adminAccess';
import { useAdminOrgChoice } from './useAdminOrg';

export interface EffectiveAdminOrg {
    orgId: string | null;
    /** A platform admin has "All organisations" chosen: the page asks for one instead. */
    needsChoice: boolean;
}

export function useEffectiveAdminOrgId(user: Readonly<Record<string, unknown>> | null | undefined): EffectiveAdminOrg {
    const choice = useAdminOrgChoice();
    if (choice?.isPlatformAdmin) return { orgId: choice.orgId, needsChoice: !choice.orgId };
    return { orgId: homeOrgIdOf(user), needsChoice: false };
}
