// Setting up Teams meeting notes for the organisation: the setup guide, the
// admin consent link, a test of the admin's own connection, organisation-wide
// import (application permissions) and the members overview. All five read
// /api/teams-setup, which takes no organisation from the request and always
// acts on the caller's own (server/routes/teamsSetup.mts), so they are shown
// for the viewer's home organisation only; for any other organisation a notice
// stands in their place, so one organisation's setup never shows under
// another's name.
//
// The admin dashboard draws them on the Microsoft 365 row; outside it (the
// Settings pages a phone keeps) they stay under the Teams meeting-notes settings.

import HomeOrgOnlyNotice from '@/components/admin/organisation/HomeOrgOnlyNotice';
import TeamsAppImportPanel from './TeamsAppImportPanel';
import TeamsConnectionTest from './TeamsConnectionTest';
import TeamsConsentLinkCard from './TeamsConsentLinkCard';
import TeamsMembersOverview from './TeamsMembersOverview';
import TeamsSetupGuide from './TeamsSetupGuide';

interface TeamsSetupCardsProps {
    /** The chosen organisation is the viewer's own: the only one these cards can act on. */
    homeOrg: boolean;
}

export default function TeamsSetupCards({ homeOrg }: TeamsSetupCardsProps) {
    if (!homeOrg) return <HomeOrgOnlyNotice />;
    return (
        <div className="flex flex-col gap-6">
            <TeamsSetupGuide />
            <TeamsConsentLinkCard />
            <TeamsConnectionTest />
            <TeamsAppImportPanel />
            <TeamsMembersOverview />
        </div>
    );
}
