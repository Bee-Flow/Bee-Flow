import OrgNcIntegrationsPanel from '../../components/integrations/nextcloud/OrgNcIntegrationsPanel';
import IntegrationStatusOverview from '../../components/integrations/status/IntegrationStatusOverview';
import { integrationCards } from '../../components/integrations/status/integrationStatusModel';
import { SettingsGroup } from '../../components/shared/SettingsList';
import { useOrgIntegrationAvailability } from '../../api/queries/orgIntegrationAvailability';
import { useTranslation } from '../../hooks/useTranslation';
import { homeOrgIdOf, isPlatformAdmin } from '../../utils/adminAccess';
import N8nSection from './N8nSection';
import type { SettingsUser } from './shell/settingsShellTypes';

interface OrgIntegrationSettingsProps {
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    /** The organisation to configure (the admin dashboard's); left out, the user's own. */
    orgId?: string | null;
    /**
     * The organisation is the viewer's home organisation. n8n follows the
     * organisation the dashboard names (?orgId); its access check describes the
     * viewer's own account, so it is read for the home organisation only.
     */
    homeOrg?: boolean;
}

/** The n8n configuration card: credentials, workflows as AI tools and permissions. */
function N8nCard({ homeOrg }: { homeOrg: boolean }) {
    const { t } = useTranslation();
    return (
        <SettingsGroup title="n8n" description={t('org.integ_n8n_desc')}>
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-4 py-3" data-testid="org-integrations-n8n">
                <N8nSection diagnostics={homeOrg} />
            </div>
        </SettingsGroup>
    );
}

/**
 * "Integration status": what the chosen organisation can use, per integration
 * family and per app, with a link to where each state changes, followed by the
 * configuration the organisation does itself (its Nextcloud tools, n8n).
 * Everything follows the CHOSEN organisation's availability
 * (GET /auth/organizations/{orgId}/integration-availability).
 */
export default function OrgIntegrationSettings({ user, orgId, homeOrg = true }: OrgIntegrationSettingsProps) {
    const platformAdmin = isPlatformAdmin(user);
    const effectiveOrgId = orgId ?? homeOrgIdOf(user);
    const read = useOrgIntegrationAvailability(effectiveOrgId);
    const { showN8n, showNc } = integrationCards(read, platformAdmin);
    const selfHosted = user?.featureFlags?.deploymentMode === 'self-hosted';
    return (
        <div className="flex flex-col gap-8">
            <IntegrationStatusOverview read={read} platformAdmin={platformAdmin} selfHosted={selfHosted} />
            {showNc && <OrgNcIntegrationsPanel user={user} orgId={orgId} />}
            {showN8n && <N8nCard homeOrg={homeOrg} />}
        </div>
    );
}
