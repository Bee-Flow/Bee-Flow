// The Meeting notes page of an organisation (Admin > AI & agents > Meeting
// notes; on a phone Settings > Organisation > Meeting templates): the summary
// templates, then one card per meeting source the CHOSEN organisation can use,
// from its integration availability (api/queries/orgIntegrationAvailability):
//   Nextcloud Talk   the organisation is bound to a Nextcloud
//   Google Meet      the Google family is available to it
//   Microsoft Teams  the Microsoft family is available to it
// each only with Meeting Notes for that organisation. With none of them one
// line says where a source is switched on (Access) or connected (Connections).
// A platform admin sees the cards while the answer is unknown (the fail policy
// of utils/integrationAvailability), with a note that says so.
//
// In the admin dashboard the Teams setup cards are on the Microsoft 365 row,
// so the Teams card points there; outside it they stay under the Teams card.

import { useTranslation } from '@/hooks/useTranslation';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useOrgSectionFacts } from '@/components/admin/organisation/useOrgSectionFacts';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_INFO } from '@/components/shared/adminUi';
import AdminRowLink from '@/components/meetings/AdminRowLink';
import GoogleMeetAdminPanel from '@/components/meetings/GoogleMeetAdminPanel';
import MeetingNotesAdminPanel from '@/components/meetings/MeetingNotesAdminPanel';
import SummaryTemplatesAdminPanel from '@/components/meetings/SummaryTemplatesAdminPanel';
import TeamsAdminPanel from '@/components/meetings/TeamsAdminPanel';
import HomeOrgOnlyNotice from '@/components/admin/organisation/HomeOrgOnlyNotice';
import { panelOrgId } from '@/utils/adminAccess';
import { availabilityUnknownText, familyAvailable } from '@/utils/integrationAvailability';
import type { SettingsUser } from './shell/settingsShellTypes';

interface MeetingSources {
    talk: boolean;
    meet: boolean;
    teams: boolean;
    /** The cards follow no definite answer: shown by a platform admin's fail-open, or withheld by everyone else's fail-closed. */
    unknown: boolean;
}

interface OrgMeetingNotesSectionProps {
    user: SettingsUser | null | undefined;
    /** The organisation to work on; left out, the viewer's own (Settings on a phone). */
    orgId?: string | null;
    /** The organisation is the viewer's home organisation. */
    homeOrg: boolean;
    /** Drawn by the admin dashboard, whose rail has the Microsoft 365, Access and Connections rows. */
    inDashboard: boolean;
}

/** Which meeting-source cards the chosen organisation gets. */
function useMeetingSources(user: SettingsUser | null | undefined, orgId: string | null): MeetingSources & { pending: boolean; microsoftRow: boolean } {
    const facts = useOrgSectionFacts(user, orgId);
    const read = useOrgIntegrationAvailability(orgId);
    const viewer = { platformAdmin: facts.isPlatformAdmin };
    const google = familyAvailable(read, 'google', viewer);
    const microsoft = familyAvailable(read, 'microsoft', viewer);
    const notes = familyAvailable(read, 'meetingNotes', viewer);
    const meet = notes.available && google.available;
    const teams = notes.available && microsoft.available;
    const talk = notes.available && facts.ncBound;
    const shown = meet || teams || talk;
    // Shown without a definite answer (a platform admin), or hidden only for
    // want of one (anyone else): either way the page says it could not check,
    // never that nothing is available.
    const unknown = shown
        ? notes.unknown || (meet && google.unknown) || (teams && microsoft.unknown)
        : notes.unknown || (notes.available && (google.unknown || microsoft.unknown));
    return { talk, meet, teams, unknown, pending: !!facts.availabilityPending, microsoftRow: facts.microsoft365 };
}

/** No source applies: where one is switched on or connected. */
function NoMeetingSource({ inDashboard }: { inDashboard: boolean }) {
    const { t } = useTranslation();
    return (
        <div className={`${ALERT_INFO} flex-wrap`} data-testid="meeting-sources-none">
            <span className="min-w-0 flex-1">
                {t('meetings.admin_sources.none', 'No meeting service is available to this organisation yet. Meeting notes can come from Nextcloud Talk, Google Meet or Microsoft Teams once the organisation may use one (Access) and it is connected (Connections).')}
            </span>
            {inDashboard && (
                <span className="flex gap-3">
                    <AdminRowLink path="access">{t('meetings.admin_sources.open_access', 'Open Access')}</AdminRowLink>
                    <AdminRowLink path="organisation/integrations">{t('meetings.admin_sources.open_connections', 'Open Integration status')}</AdminRowLink>
                </span>
            )}
        </div>
    );
}

/** In the dashboard, under the Teams card: the Teams setup is on the Microsoft 365 row. */
function TeamsSetupPointer({ homeOrg, microsoftRow }: { homeOrg: boolean; microsoftRow: boolean }) {
    const { t } = useTranslation();
    // Another organisation's Teams setup is nowhere: the setup routes act on the caller's own.
    if (!homeOrg || !microsoftRow) return null;
    return (
        <p className={`${ALERT_INFO} flex-wrap`} data-testid="teams-setup-pointer">
            <span className="min-w-0 flex-1">
                {t('meetings.admin_sources.teams_setup_elsewhere', 'Admin consent, the connection test and organisation-wide import for Teams are on the Microsoft 365 page.')}
            </span>
            <AdminRowLink path="organisation/azure">{t('meetings.admin_sources.open_m365', 'Open Microsoft 365')}</AdminRowLink>
        </p>
    );
}

export default function OrgMeetingNotesSection({ user, orgId: orgIdProp, homeOrg, inDashboard }: OrgMeetingNotesSectionProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const sources = useMeetingSources(user, orgId);
    const none = !sources.talk && !sources.meet && !sources.teams && !sources.unknown;
    return (
        <div className="flex flex-col gap-8">
            {/* The summary templates are the caller's own organisation's (the route takes none). */}
            {homeOrg ? <SummaryTemplatesAdminPanel /> : <HomeOrgOnlyNotice />}
            <LoadingState loading={sources.pending}>
                {sources.unknown && <p className={ALERT_INFO} data-testid="meeting-sources-unknown">{availabilityUnknownText(t)}</p>}
                {sources.talk && <MeetingNotesAdminPanel user={user} orgId={orgId} />}
                {sources.meet && <GoogleMeetAdminPanel user={user} orgId={orgId} />}
                {sources.teams && (
                    <div className="flex flex-col gap-3">
                        <TeamsAdminPanel user={user} orgId={orgId} showSetup={!inDashboard} />
                        {inDashboard && <TeamsSetupPointer homeOrg={homeOrg} microsoftRow={sources.microsoftRow} />}
                    </div>
                )}
                {none && <NoMeetingSource inDashboard={inDashboard} />}
            </LoadingState>
        </div>
    );
}
