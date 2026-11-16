// The Nextcloud page of an organisation (Admin > Connections > Nextcloud; on a
// phone Settings > Organisation > Nextcloud Sync), for the CHOSEN organisation
// (api/queries/orgIntegrationAvailability), never the viewer's session:
//   bound to a Nextcloud          the user sync (NextcloudSyncPanel)
//   not bound, the viewer's own   pairing a Nextcloud (OrgNcPairingPanel), when
//                                 the server offers pairing (the connector is on)
//   anything else                 one line that says the organisation has no Nextcloud
// Pairing codes are the caller's own organisation's (the route takes none), so
// another organisation never gets the pairing panel. Talk meeting notes are on
// the Meeting notes page (OrgMeetingNotesSection).

import { useTranslation } from '@/hooks/useTranslation';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useOrgSectionFacts } from '@/components/admin/organisation/useOrgSectionFacts';
import NextcloudSyncPanel from '@/components/integrations/nextcloud/NextcloudSyncPanel';
import OrgNcPairingPanel from '@/components/integrations/nextcloud/OrgNcPairingPanel';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_INFO } from '@/components/shared/adminUi';
import { panelOrgId } from '@/utils/adminAccess';
import { availabilityReasonText } from '@/utils/integrationAvailability';
import type { SettingsUser } from './shell/settingsShellTypes';

interface OrgNextcloudSectionProps {
    user: SettingsUser | null | undefined;
    /** The organisation to work on; left out, the viewer's own (Settings on a phone). */
    orgId?: string | null;
    /** The organisation is the viewer's home organisation. */
    homeOrg: boolean;
}

type NextcloudView = 'pending' | 'sync' | 'pairing' | 'none';

/** What the page shows for the chosen organisation. */
function useNextcloudView(user: SettingsUser | null | undefined, orgId: string | null, homeOrg: boolean): NextcloudView {
    const facts = useOrgSectionFacts(user, orgId);
    const read = useOrgIntegrationAvailability(orgId);
    if (facts.availabilityPending) return 'pending';
    if (facts.ncBound) return 'sync';
    // Without an answer pairing follows the fail policy: offered to a platform admin only.
    const answer = !read.isError && read.data?.nextcloud ? read.data : null;
    const pairingOffered = answer ? !!answer.nextcloud.pairingAvailable : facts.isPlatformAdmin;
    return homeOrg && pairingOffered ? 'pairing' : 'none';
}

export default function OrgNextcloudSection({ user, orgId: orgIdProp, homeOrg }: OrgNextcloudSectionProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const view = useNextcloudView(user, orgId, homeOrg);
    return (
        <LoadingState loading={view === 'pending'}>
            {view === 'sync' && <NextcloudSyncPanel user={user} orgId={orgId} />}
            {view === 'pairing' && <OrgNcPairingPanel />}
            {view === 'none' && <p className={ALERT_INFO} data-testid="nextcloud-not-bound">{availabilityReasonText(t, 'not_bound')}</p>}
        </LoadingState>
    );
}
