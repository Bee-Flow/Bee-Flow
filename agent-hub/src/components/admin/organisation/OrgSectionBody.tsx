// The panel of one section of the Organisation tab, for one organisation, in
// the dashboard's one page frame (dashboard/AdminPage), which draws the page
// header (the rail row's label and description) and the width. The panels are
// the ones Settings > Organisation rendered (pages/settings) and the editors the
// old pages held, handed the organisation to work on; they draw no page header
// of their own.

import type { ReactNode } from 'react';
import Microsoft365Panel from '@/components/integrations/azure';
import OrgAiContextEditor from '@/components/admin/org/OrgAiContextEditor';
import OrgAiParticipationEditor from '@/components/admin/org/OrgAiParticipationEditor';
import OrgCollabEditor from '@/components/admin/org/OrgCollabEditor';
import OrgCustomTiersPanel from '@/components/admin/org/OrgCustomTiersPanel';
import OrgImageLimitsSection from '@/components/admin/org/imageLimits/OrgImageLimitsSection';
import OrgMemoryEditor from '@/components/admin/org/OrgMemoryEditor';
import McpLibraryPage from '@/components/mcpLibrary/McpLibraryPage';
import { isPlatformAdmin } from '@/utils/adminAccess';
import SystemKnowledgeBasesPanel from '@/components/knowledge/SystemKnowledgeBasesPanel';
import OrganisationSection from '@/pages/settings/OrganisationSection';
import OrgIntegrationSettings from '@/pages/settings/OrgIntegrationSettings';
import type { SettingsUser } from '@/pages/settings/shell/settingsShellTypes';
import AdminPage, { type AdminPageWidth } from '@/components/admin/dashboard/AdminPage';
import HomeOrgOnlyNotice from './HomeOrgOnlyNotice';

/**
 * The sections at the settings width: the forms and the cards that read as one
 * (Meeting notes, Microsoft 365, Integration status). The rest are lists, grids
 * and tables at the whole pane: Knowledge bases, Models (the tiers table),
 * Learning Center and MCP servers.
 */
const SETTINGS_WIDTH_SECTIONS: ReadonlySet<string> = new Set([
    'info', 'auth', 'license', 'encryption', 'conversations', 'memory', 'projects', 'integration-cache', 'mcp-access',
    'github-sync', 'nextcloud-sync', 'meeting-notes', 'azure', 'integrations',
]);

/** The width of a section's page. */
export function orgSectionWidth(section: string): AdminPageWidth {
    return SETTINGS_WIDTH_SECTIONS.has(section) ? 'settings' : 'wide';
}

/** Sections OrganisationSection draws under the Settings tab id they had. */
const SETTINGS_SECTION_IDS: Readonly<Record<string, string>> = {
    'meeting-notes': 'meeting_templates',
};

export interface OrgSectionBodyProps {
    /** The page header: the rail row's label (none outside the dashboard). */
    title?: string;
    description?: string;
    section: string;
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    orgId: string;
    /** The organisation is the viewer's home organisation. */
    homeOrg: boolean;
}

/** The panels mounted here directly (the editors of the old AI context page, the old Users tabs, the old org settings page). */
const DIRECT_PANELS: Readonly<Record<string, (p: OrgSectionBodyProps) => ReactNode>> = {
    // Integration status: the integrations' own settings. Who gets which integration is Access > Grants.
    integrations: (p) => <OrgIntegrationSettings user={p.user} orgId={p.orgId} homeOrg={p.homeOrg} />,
    // Microsoft 365: the organisation's Microsoft identity, Teams meeting notes and Entra ID group sync.
    azure: (p) => <Microsoft365Panel user={p.user} orgId={p.orgId} />,
    conversations: (p) => <OrgAiContextEditor orgId={p.orgId} />,
    memory: (p) => <OrgMemoryEditor orgId={p.orgId} />,
    // The row only shows where the organisation can use Projects.
    projects: (p) => (
        <div className="space-y-8">
            <OrgAiParticipationEditor orgId={p.orgId} />
            <OrgCollabEditor orgId={p.orgId} />
        </div>
    ),
    // The organisation's own model tiers, and the limits on images people send to a model.
    models: (p) => (
        <div className="space-y-8">
            <OrgCustomTiersPanel />
            <OrgImageLimitsSection orgId={p.orgId} />
        </div>
    ),
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
        <AdminPage title={props.title} description={props.description} width={orgSectionWidth(props.section)}>
            <SectionPanel {...props} />
        </AdminPage>
    );
}
