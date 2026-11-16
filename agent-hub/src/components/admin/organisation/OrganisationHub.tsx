// The admin dashboard's Organisation tab (admin/organisation/<section>): what
// Settings > Organisation held, for the organisation the dashboard works on. The
// sections are rows of the dashboard rail itself (dashboard/adminRailRows), so
// this renders the open section only, in the dashboard's page frame
// (dashboard/AdminPage, headed by the rail row's label); the section is the URL,
// the section ids are the old Settings segments (orgSections). A section the
// viewer does not get says why on its own address (OrgSectionUnavailable), never
// another section in its place; no section opens the first one they get. A
// platform admin works on the organisation chosen in the scope bar and is asked
// to choose one while "All organisations" is chosen; anyone else works on their
// home organisation.

import type { ReactNode } from 'react';
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
import OrgSectionBody, { orgSectionWidth } from './OrgSectionBody';
import OrgSectionUnavailable from './OrgSectionUnavailable';
import { awaitingOrgSection, openOrgSection, orgSectionUnavailableReason, visibleOrgSections } from './orgSections';
import { useOrgSectionFacts } from './useOrgSectionFacts';
import { useShellProps } from '@/authedApp/useShellProps';

type HubUser = SettingsUser & { enabledIntegrations?: string[]; [key: string]: unknown };

/** The page header the dashboard gives the open section (its rail row's label and description). */
interface PageHeading {
    title?: string;
    description?: string;
}

interface OrganisationHubProps extends PageHeading {
    user?: HubUser | null;
    activeSection?: string;
}

/** The section area: the choice notice, a spinner while the organisations load, or the section's panel. */
function SectionArea({ user, section, heading }: { user: HubUser | null | undefined; section: string; heading: PageHeading }) {
    const choice = useAdminOrgChoice();
    const { orgId, needsChoice } = useEffectiveAdminOrgId(user);
    const page = (children: ReactNode) => <AdminPage {...heading} width={orgSectionWidth(section)}>{children}</AdminPage>;
    if (choice?.isPlatformAdmin && !choice.organizationsLoaded) return page(<Spinner size="sm" />);
    if (needsChoice || !orgId) return page(<ChooseOrgNotice noOrgs={(choice?.organizations.length ?? 0) === 0} />);
    // The requests on the primary-organisation routes name the organisation only
    // for a platform admin (contract: anyone else sends none). The key drops
    // every panel's unsaved edits when the organisation changes.
    return (
        <AdminOrgScopeProvider value={choice?.isPlatformAdmin ? orgId : null}>
            <div key={orgId} className="flex min-h-0 flex-1 flex-col">
                <OrgSectionBody {...heading} section={section} user={user} orgId={orgId} homeOrg={orgId === homeOrgIdOf(user)} />
            </div>
        </AdminOrgScopeProvider>
    );
}

export default function OrganisationHub({ user: userProp, activeSection = '', title, description }: OrganisationHubProps) {
    // Inside the app shell the signed-in person comes from context; a host
    // outside it (a test, a kit) still hands them as a prop.
    const { user } = useShellProps({ user: userProp });
    const { orgId } = useEffectiveAdminOrgId(user);
    const facts = useOrgSectionFacts(user, orgId);
    const heading: PageHeading = { title, description };
    // A deep link to a section that follows the organisation's availability
    // waits for the answer instead of opening the first section meanwhile.
    const waiting = awaitingOrgSection(facts, activeSection);
    const open = openOrgSection(visibleOrgSections(facts), activeSection);
    const active = waiting || !open.available ? '' : open.id;
    useAdminScopeOverride(adminSectionScope('organisation', active || undefined));

    if (waiting) return <AdminPage {...heading} testId="org-section-pending"><Spinner size="sm" /></AdminPage>;
    if (open.id && !open.available) {
        return (
            <AdminPage {...heading}>
                <OrgSectionUnavailable section={open.id} reason={orgSectionUnavailableReason(open.id, facts)} />
            </AdminPage>
        );
    }
    return (
        <div className="flex min-h-full flex-col" data-testid={`org-section-body-${active}`}>
            {active && <SectionArea user={user} section={active} heading={heading} />}
        </div>
    );
}
