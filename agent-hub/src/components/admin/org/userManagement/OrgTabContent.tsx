import NextcloudSyncPanel from '../../../integrations/nextcloud/NextcloudSyncPanel';
import OrgCustomTiersPanel from '../OrgCustomTiersPanel';
import OrgInvitationsSection from './OrgInvitationsSection';
import OrgOnlyNotice from './OrgOnlyNotice';
import OrgRolesSection from './OrgRolesSection';
import type { AdminCurrentUser, AdminUser } from './types';
import type { OrgTabMode } from './useOrgTabTarget';

/** The tabs of this screen that work on one organisation: its invitations, roles, model tiers and Nextcloud sync. */
export const ORG_ONLY_SECTIONS = ['invitations', 'org-roles', 'custom-tiers', 'sync'] as const;

interface OrgTabContentProps {
    section: string;
    mode: OrgTabMode;
    users: AdminUser[];
    currentUser: AdminCurrentUser | null | undefined;
}

/** The content of one organisation-only tab, or the notice that says which organisation to choose first. */
export default function OrgTabContent({ section, mode, users, currentUser }: OrgTabContentProps) {
    if (mode !== 'ok') return <OrgOnlyNotice mode={mode} />;
    if (section === 'invitations') return <OrgInvitationsSection />;
    if (section === 'org-roles') return <OrgRolesSection users={users} currentUser={currentUser} />;
    if (section === 'custom-tiers') return <OrgCustomTiersPanel />;
    if (section === 'sync') return <NextcloudSyncPanel user={currentUser as { organizationId?: string | null }} />;
    return null;
}
