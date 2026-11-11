import { AdminOrgScopeProvider } from '@/api/adminOrgScope';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useEffectiveAdminOrgId } from '@/components/admin/dashboard/useEffectiveAdminOrgId';
import NextcloudSyncPanel from '../../../integrations/nextcloud/NextcloudSyncPanel';
import OrgCustomTiersPanel from '../OrgCustomTiersPanel';
import OrgInvitationsSection from './OrgInvitationsSection';
import OrgRolesSection from './OrgRolesSection';
import type { AdminCurrentUser, AdminUser } from './types';

/** The tabs of this screen that work on one organisation: its invitations, roles, model tiers and Nextcloud sync. */
export const ORG_ONLY_SECTIONS = ['invitations', 'org-roles', 'custom-tiers', 'sync'] as const;

/** The organisation the organisation-only tabs work on (dashboard/useEffectiveAdminOrgId). */
interface OrgTabTarget {
    /** A platform admin has "All organisations" chosen: the tab asks for one. */
    needsChoice: boolean;
    /** The server has no organisations at all. */
    noOrgs: boolean;
    /** The organisation the requests name (a platform admin's choice); null: the caller's own, no orgId sent. */
    scopeOrgId: string | null;
}

/** The organisation the organisation-only tabs work on: the dashboard's (useEffectiveAdminOrgId). */
export function useOrgTabTarget(currentUser: AdminCurrentUser | null | undefined): OrgTabTarget {
    const choice = useAdminOrgChoice();
    const { orgId, needsChoice } = useEffectiveAdminOrgId(currentUser);
    return {
        needsChoice,
        noOrgs: !!choice?.organizationsLoaded && choice.organizations.length === 0,
        scopeOrgId: choice?.isPlatformAdmin ? orgId : null,
    };
}

interface OrgTabContentProps {
    section: string;
    target: OrgTabTarget;
    users: AdminUser[];
    currentUser: AdminCurrentUser | null | undefined;
}

function TabBody({ section, users, currentUser, scopeOrgId }: Omit<OrgTabContentProps, 'target'> & { scopeOrgId: string | null }) {
    if (section === 'invitations') return <OrgInvitationsSection />;
    if (section === 'org-roles') return <OrgRolesSection users={users} currentUser={currentUser} />;
    if (section === 'custom-tiers') return <OrgCustomTiersPanel />;
    if (section === 'sync') {
        const ncUser = currentUser as { organizationId?: string | null };
        return scopeOrgId ? <NextcloudSyncPanel user={ncUser} orgId={scopeOrgId} /> : <NextcloudSyncPanel user={ncUser} />;
    }
    return null;
}

/**
 * The content of one organisation-only tab, for the organisation the dashboard works on, or the notice
 * that asks a platform admin to choose one. The key drops a tab's unsaved edits when the organisation changes.
 */
export default function OrgTabContent({ section, target, users, currentUser }: OrgTabContentProps) {
    if (target.needsChoice) return <ChooseOrgNotice noOrgs={target.noOrgs} />;
    return (
        <AdminOrgScopeProvider value={target.scopeOrgId}>
            <div key={target.scopeOrgId ?? 'own'}>
                <TabBody section={section} users={users} currentUser={currentUser} scopeOrgId={target.scopeOrgId} />
            </div>
        </AdminOrgScopeProvider>
    );
}
