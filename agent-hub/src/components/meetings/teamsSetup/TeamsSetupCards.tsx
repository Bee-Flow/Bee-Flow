// Setting up Teams meeting notes for the organisation, top to bottom in the
// order an organisation admin needs it:
//   0. how a meeting becomes a note, and who turns speech into text;
//   1. what a member needs (plan, access, Microsoft account and licence);
//   2. the two ways Bee Flow can reach the meetings, each with its own action
//      inside its card: the approval link for Microsoft under "members connect
//      their own account", the switch and test under organisation-wide import;
//   3. a test of the admin's own connection;
//   4. who is ready, per member.
// All of them read /api/teams-setup, which takes no organisation from the
// request and always acts on the caller's own (server/routes/teamsSetup.mts),
// so they are shown for the viewer's home organisation only; for any other
// organisation a notice stands in their place, so one organisation's setup
// never shows under another's name.
//
// The admin dashboard draws them on the Microsoft 365 row; outside it (the
// Settings pages a phone keeps) they stay under the Teams meeting-notes settings.

import HomeOrgOnlyNotice from '@/components/admin/organisation/HomeOrgOnlyNotice';
import { useTranslation } from '@/hooks/useTranslation';
import TeamsAppImportPanel from './TeamsAppImportPanel';
import TeamsConnectionTest from './TeamsConnectionTest';
import TeamsConsentLinkCard from './TeamsConsentLinkCard';
import TeamsHowItWorksCard from './TeamsHowItWorksCard';
import TeamsMembersOverview from './TeamsMembersOverview';
import TeamsRequirementsCard from './TeamsRequirementsCard';
import TeamsSetupGuide from './TeamsSetupGuide';

interface TeamsSetupCardsProps {
    /** The chosen organisation is the viewer's own: the only one these cards can act on. */
    homeOrg: boolean;
}

export default function TeamsSetupCards({ homeOrg }: TeamsSetupCardsProps) {
    const { t } = useTranslation();
    if (!homeOrg) return <HomeOrgOnlyNotice />;
    return (
        <div className="flex flex-col gap-6">
            <TeamsHowItWorksCard />
            <TeamsRequirementsCard />
            <TeamsSetupGuide consent={<TeamsConsentLinkCard embedded />} appImport={<TeamsAppImportPanel embedded />} />
            <section className="flex flex-col gap-2" aria-labelledby="teams-test-title">
                <h4 id="teams-test-title" className="text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.ui.test_title')}</h4>
                <TeamsConnectionTest />
            </section>
            <TeamsMembersOverview />
        </div>
    );
}
