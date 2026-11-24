/**
 * Who the Cowork page is shown to, as far as it decides anything: may this user open the organisation's panel
 * (./coworkSheetPanels.ts `org`). The same checks as the admin screens (utils/adminAccess.ts); the server checks again.
 */
import { homeOrgIdOf, isHomeOrgAdmin, isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';
import type { CoworkViewer } from '@/api/cowork.types';

/** An administrator of the server or of the user's home organisation, who has a home organisation. */
export function administersOrg(user: CoworkViewer | null | undefined): boolean {
    if (!user || !homeOrgIdOf(user)) return false;
    return isPlatformAdmin(user) || isOrgAdminRole(user.orgRole) || isHomeOrgAdmin(user);
}
