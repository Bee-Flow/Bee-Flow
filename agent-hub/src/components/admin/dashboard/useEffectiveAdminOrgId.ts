// The organisation an organisation page works on (contract for every package
// that renders one in the dashboard):
//   inside the dashboard   a platform admin: the organisation chosen in the
//                          scope bar, or `needsChoice` while "All
//                          organisations" is chosen; anyone else: their home
//                          organisation;
//   outside the dashboard  (no AdminOrgProvider) the home organisation.

import { homeOrgIdOf } from '@/utils/adminAccess';
import { useAdminOrgChoice, type AdminOrgChoice } from './useAdminOrg';

export interface EffectiveAdminOrg {
    orgId: string | null;
    /** A platform admin has "All organisations" chosen: the page asks for one instead. */
    needsChoice: boolean;
}

/** The same answer from a choice in hand (the dashboard shell, which holds the choice outside its provider). */
export function effectiveAdminOrgOf(choice: AdminOrgChoice | null, user: Readonly<Record<string, unknown>> | null | undefined): EffectiveAdminOrg {
    if (choice?.isPlatformAdmin) return { orgId: choice.orgId, needsChoice: !choice.orgId };
    return { orgId: homeOrgIdOf(user), needsChoice: false };
}

export function useEffectiveAdminOrgId(user: Readonly<Record<string, unknown>> | null | undefined): EffectiveAdminOrg {
    return effectiveAdminOrgOf(useAdminOrgChoice(), user);
}
