import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { homeOrgIdOf, isPlatformAdmin } from '@/utils/adminAccess';

/**
 * Which organisation an organisation-only tab of this screen works on.
 *
 *   ok       the viewer's home organisation (an organisation admin, or outside the dashboard), or the
 *            chosen organisation when it is the platform admin's own.
 *   choose   a platform admin with "All organisations" chosen: nothing to show until one is.
 *   foreign  a platform admin who chose an organisation other than their own. The invitation, organisation-role and
 *            model-tier routes act on the caller's home organisation, so the tab says so instead of
 *            showing another organisation's name over this organisation's data.
 */
export type OrgTabMode = 'ok' | 'choose' | 'foreign';

export default function useOrgTabTarget(user: Readonly<Record<string, unknown>> | null | undefined): OrgTabMode {
    const choice = useAdminOrgChoice();
    if (!choice || !isPlatformAdmin(user)) return 'ok';
    if (!choice.orgId) return 'choose';
    return choice.orgId === homeOrgIdOf(user) ? 'ok' : 'foreign';
}
