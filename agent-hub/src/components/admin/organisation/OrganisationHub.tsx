// The admin dashboard's Organisation tab (admin/organisation/<section>): what
// Settings > Organisation held, for the organisation the dashboard works on. A
// StudioShell with a SectionNav, the section is the URL; the section ids are the
// old Settings segments (orgSections). A platform admin works on the
// organisation chosen in the scope bar and is asked to choose one while "All
// organisations" is chosen; anyone else works on their home organisation.

import { useTranslation } from '@/hooks/useTranslation';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import Spinner from '@/components/shared/Spinner';
import { AdminOrgScopeProvider } from '@/api/adminOrgScope';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import { ServerWideMark, serverWideLast } from '@/components/admin/dashboard/serverWideNav';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import { useEffectiveAdminOrgId } from '@/components/admin/dashboard/useEffectiveAdminOrgId';
import { homeOrgIdOf } from '@/utils/adminAccess';
import type { SettingsUser } from '@/pages/settings/shell/settingsShellTypes';
import OrgSectionBody from './OrgSectionBody';
import { ORG_HUB_GROUPS, orgAzureSection, visibleOrgSections } from './orgSections';
import { useOrgSectionFacts } from './useOrgSectionFacts';

type HubUser = SettingsUser & { enabledIntegrations?: string[]; [key: string]: unknown };

interface OrganisationHubProps {
    user?: HubUser | null;
    activeSection?: string;
    onNavigate?: (path: string) => void;
}

/** The section area: the choice notice, a spinner while the organisations load, or the section's panel. */
function SectionArea({ user, section, azureConfig }: { user: HubUser | null | undefined; section: string; azureConfig: boolean }) {
    const choice = useAdminOrgChoice();
    const { orgId, needsChoice } = useEffectiveAdminOrgId(user);
    if (choice?.isPlatformAdmin && !choice.organizationsLoaded) {
        return <div className="p-6"><Spinner size="sm" /></div>;
    }
    if (needsChoice || !orgId) return <ChooseOrgNotice noOrgs={(choice?.organizations.length ?? 0) === 0} />;
    // The requests on the primary-organisation routes name the organisation only
    // for a platform admin (contract: anyone else sends none). The key drops
    // every panel's unsaved edits when the organisation changes.
    return (
        <AdminOrgScopeProvider value={choice?.isPlatformAdmin ? orgId : null}>
            <div key={orgId} className="flex min-h-0 flex-1 flex-col">
                <OrgSectionBody section={section} user={user} orgId={orgId} homeOrg={orgId === homeOrgIdOf(user)} azureConfig={azureConfig} />
            </div>
        </AdminOrgScopeProvider>
    );
}

export default function OrganisationHub({ user, activeSection = '', onNavigate }: OrganisationHubProps) {
    const { t } = useTranslation();
    const { orgId } = useEffectiveAdminOrgId(user);
    const facts = useOrgSectionFacts(user, orgId);
    const sections = visibleOrgSections(facts);
    const active = sections.some(s => s.id === activeSection) ? activeSection : (sections[0]?.id ?? '');
    const azureConfig = orgAzureSection(facts) === 'config';
    // The Azure services setup is server-wide (the scope data in adminTabs says so).
    const isServerWide = (id: string) => id === 'azure' && azureConfig && adminSectionScope('organisation', 'azure', 'config') === 'instance';
    useAdminScopeOverride(adminSectionScope('organisation', active));
    const groupLabel = (id: string) => {
        const group = ORG_HUB_GROUPS.find(g => g.id === id);
        return group ? t(group.labelKey, group.labelFallback) : '';
    };

    return (
        <StudioShell
            responsive
            sidebarTitle={t('settings.organisation', 'Organisation')}
            sidebar={(
                <SectionNav
                    label={t('settings.organisation', 'Organisation')}
                    items={serverWideLast(sections, s => isServerWide(s.id)).map(s => ({
                        id: s.id,
                        icon: s.icon,
                        label: t(s.labelKey),
                        testId: `org-section-${s.id}`,
                        ...(s.serverWide
                            ? { group: t('admin.scope_instance', 'Whole server'), groupDivider: true, mark: <ServerWideMark /> }
                            : { group: groupLabel(s.group), groupDivider: s.group !== sections[0]?.group }),
                    }))}
                    activeId={active}
                    onSelect={(id) => { if (onNavigate) onNavigate(`admin/organisation/${id}`); }}
                />
            )}
        >
            <div className="flex min-h-full flex-col p-6 md:p-8" data-testid={`org-section-body-${active}`}>
                {active && <SectionArea user={user} section={active} azureConfig={azureConfig} />}
            </div>
        </StudioShell>
    );
}
