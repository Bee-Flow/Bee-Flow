// The panel of one section of the Organisation tab, for one organisation, in
// the dashboard's one page frame (dashboard/AdminPage). The panels are the ones
// Settings > Organisation rendered (pages/settings) and the editors the old
// pages held, handed the organisation to work on; they still draw their own
// header, so the frame adds none yet.

import type { ReactNode } from 'react';
import GroupSyncPanel from '@/components/integrations/azure/GroupSyncPanel';
import OrgAiContextEditor from '@/components/admin/org/OrgAiContextEditor';
import OrgAiParticipationEditor from '@/components/admin/org/OrgAiParticipationEditor';
import OrgCollabEditor from '@/components/admin/org/OrgCollabEditor';
import OrgCustomTiersPanel from '@/components/admin/org/OrgCustomTiersPanel';
import OrgMemoryEditor from '@/components/admin/org/OrgMemoryEditor';
import McpLibraryPage from '@/components/mcpLibrary/McpLibraryPage';
import { isPlatformAdmin } from '@/utils/adminAccess';
import SystemKnowledgeBasesPanel from '@/components/knowledge/SystemKnowledgeBasesPanel';
import OrganisationSection from '@/pages/settings/OrganisationSection';
import OrgIntegrationSettings from '@/pages/settings/OrgIntegrationSettings';
import type { SettingsUser } from '@/pages/settings/shell/settingsShellTypes';
import { useTranslation } from '@/hooks/useTranslation';
import AdminPage, { type AdminPageWidth } from '@/components/admin/dashboard/AdminPage';
import HomeOrgOnlyNotice from './HomeOrgOnlyNotice';

/**
 * The sections at the settings width: the forms (each of these panels already
 * keeps to a narrower column). The rest (lists, grids, the meeting panels) keep
 * the whole pane until their own wave gives them a width.
 */
const SETTINGS_WIDTH_SECTIONS: ReadonlySet<string> = new Set([
    'info', 'auth', 'license', 'encryption', 'conversations', 'memory', 'projects', 'integration-cache', 'mcp-access',
    'github-sync', 'nextcloud-sync',
]);

/** The width of a section's page. */
function orgSectionWidth(section: string): AdminPageWidth {
    return SETTINGS_WIDTH_SECTIONS.has(section) ? 'settings' : 'wide';
}

/** Sections OrganisationSection draws under the Settings tab id they had. */
const SETTINGS_SECTION_IDS: Readonly<Record<string, string>> = {
    'meeting-notes': 'meeting_templates',
};

export interface OrgSectionBodyProps {
    section: string;
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    orgId: string;
    /** The organisation is the viewer's home organisation. */
    homeOrg: boolean;
}

/** Integration status: the integrations' own settings. Who gets which integration is Access > Grants. */
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

/** The panels mounted here directly (the editors of the old AI context page, the old Users tabs, the old org settings page). */
const DIRECT_PANELS: Readonly<Record<string, (p: OrgSectionBodyProps) => ReactNode>> = {
    integrations: (p) => <IntegrationsSection user={p.user} orgId={p.orgId} homeOrg={p.homeOrg} />,
    // Microsoft 365: the organisation's own Entra ID group sync.
    azure: (p) => <GroupSyncPanel user={p.user} orgId={p.orgId} />,
    conversations: (p) => <OrgAiContextEditor orgId={p.orgId} />,
    memory: (p) => <OrgMemoryEditor orgId={p.orgId} />,
    // The row only shows where the organisation can use Projects.
    projects: (p) => (
        <div className="space-y-8">
            <OrgAiParticipationEditor orgId={p.orgId} />
            <OrgCollabEditor orgId={p.orgId} />
        </div>
    ),
    models: () => <OrgCustomTiersPanel />,
    // The organisation's remote MCP servers; the server-wide ones are the whole-server MCP servers row.
    mcp: (p) => <McpLibraryPage view="org" isServerAdmin={isPlatformAdmin(p.user)} />,
    // The system knowledge bases are switched on for the caller's own organisation (the route takes none).
    'knowledge-bases': (p) => (p.homeOrg ? <SystemKnowledgeBasesPanel /> : <HomeOrgOnlyNotice />),
};

function SectionPanel(props: OrgSectionBodyProps) {
    const { section, user, orgId, homeOrg } = props;
    if (Object.hasOwn(DIRECT_PANELS, section)) return <>{DIRECT_PANELS[section](props)}</>;
    // OrganisationSection names its sections as the Settings tab ids did (mcp_access, ...).
    const settingsId = Object.hasOwn(SETTINGS_SECTION_IDS, section) ? SETTINGS_SECTION_IDS[section] : section.replaceAll('-', '_');
    return <OrganisationSection user={user} activeSection={settingsId} orgId={orgId} homeOrg={homeOrg} />;
}

export default function OrgSectionBody(props: OrgSectionBodyProps) {
    return (
        <AdminPage width={orgSectionWidth(props.section)}>
            <SectionPanel {...props} />
        </AdminPage>
    );
}
