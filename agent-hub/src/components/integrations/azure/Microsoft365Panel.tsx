// The Microsoft 365 page of an organisation (Admin > Connections > Microsoft
// 365): what the organisation does with Microsoft beyond signing in.
//   Entra ID group sync     the organisation's own groups and members (GroupSyncPanel)
//   Identities and directory  the platform admin's: pending identity links and
//                           which organisation the directory syncs into
//                           (security/MicrosoftIdentityPanel; server-wide routes)
//   Teams meeting notes setup  admin consent, connection test, organisation-wide
//                           import and the members overview, for the viewer's
//                           own organisation only (the routes take none), when
//                           the organisation has Meeting Notes and Microsoft
// The instance-wide Azure services (OpenAI, chat tiers, document processing,
// the Microsoft sign-in app) are not here: each has its one home in AI
// configuration, Platform services and Sign-in & SSO.

import { useTranslation } from '@/hooks/useTranslation';
import { useSsoProvidersQuery } from '@/api/queries/adminConfigReads';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { familyAvailable } from '@/utils/integrationAvailability';
import MicrosoftIdentityPanel from '@/components/admin/security/MicrosoftIdentityPanel';
import type { OrgFactsUser } from '@/components/admin/organisation/orgSections';
import { useOrgSectionFacts } from '@/components/admin/organisation/useOrgSectionFacts';
import TeamsSetupCards from '@/components/meetings/teamsSetup/TeamsSetupCards';
import { SettingsGroup } from '@/components/shared/SettingsList';
import { homeOrgIdOf, panelOrgId } from '@/utils/adminAccess';
import GroupSyncPanel from './GroupSyncPanel';

type Microsoft365User = OrgFactsUser & { organizationId?: string } & Readonly<Record<string, unknown>>;

interface Microsoft365PanelProps {
    user?: Microsoft365User | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** The Microsoft sign-in app as GET /auth/providers answers it (the fields read here). */
interface MicrosoftSignIn { enabled?: boolean; clientId?: string; tenantId?: string }

/** The tenant names Microsoft accepts in place of a tenant GUID: no one directory. */
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers']);

/**
 * The tenant of the Microsoft sign-in app, when it names one directory. The
 * server binds the directory sync to that tenant only, so the binding form
 * starts with it.
 */
function signInTenantOf(app: MicrosoftSignIn | null | undefined): string | null {
    const tenant = app?.tenantId?.trim() ?? '';
    return tenant && !MULTI_TENANT.has(tenant.toLowerCase()) ? tenant : null;
}

/**
 * The platform admin's identity links and directory binding. They belong to a
 * Microsoft sign-in app, so they show once one is set up (or while that cannot
 * be read: the panel then says what it can).
 */
function IdentityPart() {
    const providers = useSsoProvidersQuery<{ microsoft?: MicrosoftSignIn }>();
    if (providers.isPending) return null;
    const app = providers.data?.microsoft;
    const known = providers.isSuccess && providers.data !== null;
    if (known && !app?.enabled && !app?.clientId) return null;
    return <MicrosoftIdentityPanel ssoTenantId={signInTenantOf(app)} />;
}

export default function Microsoft365Panel({ user, orgId: orgIdProp }: Microsoft365PanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const homeOrg = orgId !== null && orgId === homeOrgIdOf(user);
    const facts = useOrgSectionFacts(user, orgId);
    // The same rule as the Teams card on the Meeting notes page: Meeting Notes
    // and the Microsoft family for the chosen organisation.
    const microsoft = familyAvailable(useOrgIntegrationAvailability(orgId), 'microsoft', { platformAdmin: facts.isPlatformAdmin });
    const teamsSetup = facts.meetingNotes && microsoft.available;
    return (
        <div className="flex flex-col gap-8">
            <GroupSyncPanel user={user} orgId={orgId} />
            {facts.isPlatformAdmin && <IdentityPart />}
            {teamsSetup && (
                <SettingsGroup
                    title={t('azure.m365_teams_setup_title', 'Teams meeting notes setup')}
                    description={t('azure.m365_teams_setup_desc', 'Admin consent for the Teams permissions, a test of your own connection, organisation-wide import and which members are ready. The meeting-notes settings themselves are on the Meeting notes page.')}
                >
                    <TeamsSetupCards homeOrg={homeOrg} />
                </SettingsGroup>
            )}
        </div>
    );
}
