// The panel of one section of the Organisation tab, for one organisation. The
// panels are the ones Settings > Organisation rendered (pages/settings), handed
// the organisation to work on.

import OrgAzureConfigPanel from '@/components/integrations/azure/index';
import GroupSyncPanel from '@/components/integrations/azure/GroupSyncPanel';
import OrganisationSection from '@/pages/settings/OrganisationSection';
import OrgIntegrationSettings from '@/pages/settings/OrgIntegrationSettings';
import type { SettingsUser } from '@/pages/settings/shell/settingsShellTypes';
import { useTranslation } from '@/hooks/useTranslation';

export interface OrgSectionBodyProps {
    section: string;
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    orgId: string;
    /** The organisation is the viewer's home organisation. */
    homeOrg: boolean;
    /** The Azure section in its platform-admin form (the services setup). */
    azureConfig: boolean;
}

/** Integrations: the integrations' own settings. Who gets which integration is Access > Grants. */
function IntegrationsSection({ user, orgId, homeOrg }: Pick<OrgSectionBodyProps, 'user' | 'orgId' | 'homeOrg'>) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('org.integ_title')}</h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{t('org.integ_subtitle')}</p>
            </div>
            <OrgIntegrationSettings user={user} orgId={orgId} homeOrg={homeOrg} markServerWide />
        </div>
    );
}

export default function OrgSectionBody({ section, user, orgId, homeOrg, azureConfig }: OrgSectionBodyProps) {
    if (section === 'integrations') return <IntegrationsSection user={user} orgId={orgId} homeOrg={homeOrg} />;
    if (section === 'azure') return azureConfig ? <OrgAzureConfigPanel user={user} orgId={orgId} /> : <GroupSyncPanel user={user} orgId={orgId} />;
    // OrganisationSection names its sections as the Settings tab ids did (ai_context, mcp_access, ...).
    return <OrganisationSection user={user} activeSection={section.replaceAll('-', '_')} orgId={orgId} homeOrg={homeOrg} />;
}
