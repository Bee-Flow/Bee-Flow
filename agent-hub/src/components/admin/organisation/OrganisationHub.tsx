// The admin dashboard's Organisation tab (admin/organisation/<section>): what
// Settings > Organisation held, for the organisation the dashboard works on. The
// sections are rows of the dashboard rail itself (dashboard/adminRailRows), so
// this renders the open section only, at the full width; the section is the URL,
// the section ids are the old Settings segments (orgSections), and a section the
// viewer does not get opens the first one they do. A platform admin works on the
// organisation chosen in the scope bar and is asked to choose one while "All
// organisations" is chosen; anyone else works on their home organisation.

import Spinner from '@/components/shared/Spinner';
import { AdminOrgScopeProvider } from '@/api/adminOrgScope';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import AdminPage from '@/components/admin/dashboard/AdminPage';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import { useEffectiveAdminOrgId } from '@/components/admin/dashboard/useEffectiveAdminOrgId';
import { homeOrgIdOf } from '@/utils/adminAccess';
import type { SettingsUser } from '@/pages/settings/shell/settingsShellTypes';
import OrgSectionBody from './OrgSectionBody';
import { activeOrgSection, awaitingOrgSection, visibleOrgSections } from './orgSections';
import { useOrgSectionFacts } from './useOrgSectionFacts';
import { useShellProps } from '@/authedApp/useShellProps';

type HubUser = SettingsUser & { enabledIntegrations?: string[]; [key: string]: unknown };

interface OrganisationHubProps {
    user?: HubUser | null;
    activeSection?: string;
}

/** The section area: the choice notice, a spinner while the organisations load, or the section's panel. */
function SectionArea({ user, section }: { user: HubUser | null | undefined; section: string }) {
    const choice = useAdminOrgChoice();
    const { orgId, needsChoice } = useEffectiveAdminOrgId(user);
    if (choice?.isPlatformAdmin && !choice.organizationsLoaded) {
        return <AdminPage><Spinner size="sm" /></AdminPage>;
    }
    if (needsChoice || !orgId) return <AdminPage><ChooseOrgNotice noOrgs={(choice?.organizations.length ?? 0) === 0} /></AdminPage>;
    // The requests on the primary-organisation routes name the organisation only
    // for a platform admin (contract: anyone else sends none). The key drops
    // every panel's unsaved edits when the organisation changes.
    return (
        <AdminOrgScopeProvider value={choice?.isPlatformAdmin ? orgId : null}>
            <div key={orgId} className="flex min-h-0 flex-1 flex-col">
                <OrgSectionBody section={section} user={user} orgId={orgId} homeOrg={orgId === homeOrgIdOf(user)} />
            </div>
        </AdminOrgScopeProvider>
    );
}

export default function OrganisationHub({ user: userProp, activeSection = '' }: OrganisationHubProps) {
    // Inside the app shell the signed-in person comes from context; a host
    // outside it (a test, a kit) still hands them as a prop.
    const { user } = useShellProps({ user: userProp });
    const { orgId } = useEffectiveAdminOrgId(user);
    const facts = useOrgSectionFacts(user, orgId);
    // A deep link to a section that follows the organisation's availability
    // waits for the answer instead of opening the first section meanwhile.
    const waiting = awaitingOrgSection(facts, activeSection);
    const active = waiting ? '' : activeOrgSection(visibleOrgSections(facts), activeSection);
    useAdminScopeOverride(adminSectionScope('organisation', active));

    if (waiting) return <AdminPage testId="org-section-pending"><Spinner size="sm" /></AdminPage>;
    return (
        <div className="flex min-h-full flex-col" data-testid={`org-section-body-${active}`}>
            {active && <SectionArea user={user} section={active} />}
        </div>
    );
}
