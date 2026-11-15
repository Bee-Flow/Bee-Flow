// The content of the admin dashboard's current tab, always in the one page
// frame (AdminPage): the page header (the current rail row's label and
// description) and the width, decided here for every row. Two kinds of panel:
//   padded  the frame pads the page (a settings form, a list or a grid; also the
//           hubs whose sections are rail rows: with nav={false} they render the
//           section body only, without padding of their own);
//   fill    the panel owns its scrolling (a list beside a detail, an editor with
//           its own columns, a report with a drawer): it fills the pane under
//           the header. A panel that pads itself fills it edge to edge (FILL);
//           one that draws no padding of its own is inset by the header's
//           padding (FILL_INSET), so its list starts where the header starts.
// The widths per row (which kind each row is):
//   settings  the forms: Organisation info, Licence & usage, Projects, Models,
//             Conversations, Memory, Meeting notes, Preferred sign-in method,
//             Encryption, MCP client access, the Connections forms
//             (organisation/OrgSectionBody); AI configuration's Search &
//             retrieval, Direct chat and Setup status; Sign-in & SSO; Platform
//             services' Defaults and Email; Licence & features; Release notes;
//   wide      the lists, grids, tables and reports: Usage & monitoring, Access,
//             Knowledge bases, Learning Center, the organisation's MCP servers,
//             AI providers and models, Privacy Shield, Guardrail library,
//             Transcription, Connected apps, Modules, the server's MCP servers;
//   fill      the tools with a list beside a detail or their own columns:
//             Agents, Support inbox, Languages and Appearance (inset); People,
//             Organisations, Roles & permissions, Compliance (ComplianceDesktop),
//             Nextcloud instances, Website analytics and Subscriptions (they pad
//             themselves).
// The Organisation tab frames its own sections (OrganisationHub, OrgSectionBody)
// with the same header, because the width follows the section it opens.
// Either way edge to edge: no tab sits in an extra framed inset.

import type { ReactNode } from 'react';
import AgentConfigHub from '@/components/agents/AgentConfigHub';
import AIConfigPanel from '@/components/admin/ai-config';
import SecurityHub from '@/components/admin/security/SecurityHub';
import IntegrationsAdminPanel from '@/components/integrations/IntegrationsAdminPanel';
import MonitoringPanel from '@/components/admin/monitoring';
import ComplianceHub from '@/components/admin/compliance';
import SubscriptionsPanel from '@/components/admin/subscriptions';
import LanguagesPanel from '@/components/admin/languages/LanguagesPanel';
import AppearancePanel from '@/components/appearance/studio/AppearancePanel';
import AnalyticsPanel from '@/components/admin/product-website/AnalyticsPanel';
import ReleaseNotesPanel from '@/components/admin/product-website/ReleaseNotesPanel';
import ServerLicensePanel from '@/components/licensing/ServerLicensePanel';
import ModulesPanel from '@/components/admin/modules';
import SupportInboxPanel from '@/components/support/SupportInboxPanel';
import AccessPermissionsPanel from '@/components/admin/org/AccessPermissionsPanel';
import NextcloudInstancesPanel from '@/components/admin/org/NextcloudInstancesPanel';
import UserManagement from '@/components/admin/org/UserManagement';
import OrganisationHub from '@/components/admin/organisation/OrganisationHub';
import FeatureKillSwitches from '@/components/integrations/FeatureKillSwitches';
import ServerMcpPanel from '@/components/mcpLibrary/server/ServerMcpPanel';
import AdminPage, { type AdminPageWidth } from './AdminPage';

export interface AdminTabContentProps {
    activeTab: string;
    hasPermission: (perm: string) => boolean;
    agentSection: string;
    adminPath: { seg1?: string; seg2?: string; seg3?: string };
    /** The current rail row's label: the page header. */
    title?: string;
    /** The current rail row's description, under the header. */
    description?: string;
}

/** How a tab's page is framed: its width, and whether the header carries the row's description. */
interface PageFrame {
    width: AdminPageWidth;
    /** false: the header names the page only (the panel shows the page's description itself). */
    description?: boolean;
    /** A fill page: the frame insets the panel by the header's padding (AdminPage `inset`). */
    inset?: boolean;
}

/** A tab's frame, or a function of its section (the hubs whose sections differ in width). */
type FrameOf = PageFrame | ((section: string) => PageFrame);

type Panel = { render: (p: AdminTabContentProps) => ReactNode; frame: FrameOf | 'own' };

const SETTINGS: PageFrame = { width: 'settings' };
const WIDE: PageFrame = { width: 'wide' };
/** A fill panel that pads itself. */
const FILL: PageFrame = { width: 'fill' };
/** A fill panel with no padding of its own: the frame insets it by the header's padding. */
const FILL_INSET: PageFrame = { width: 'fill', inset: true };
/**
 * Usage & monitoring: the header names the page; the panel draws the description in the
 * header's one small line, joined with the scope ("… · Usage of <org>") beside the period.
 */
const WIDE_NAME_ONLY: PageFrame = { width: 'wide', description: false };

/** A frame by section: `settings` for the sections listed, the rest `wide`. */
function bySection(settings: readonly string[], fallback: string): (section: string) => PageFrame {
    return (section) => ({ width: settings.includes(section || fallback) ? 'settings' : 'wide' });
}

function Frame({ tab, frame, section, title, description, children }: { tab: string; frame: Panel['frame']; section: string; title?: string; description?: string; children: ReactNode }) {
    const page = frame === 'own' ? null : (typeof frame === 'function' ? frame(section) : frame);
    const scrolls = !page || page.width !== 'fill';
    return (
        <div className={`absolute inset-0 ${scrolls ? 'overflow-auto' : 'overflow-hidden'}`} data-testid={`admin-tab-${tab}`}>
            {page
                ? <AdminPage title={title} description={page.description === false ? undefined : description} width={page.width} inset={!!page.inset}>{children}</AdminPage>
                : children}
        </div>
    );
}

/** The Platform services sections (the child rows of the integrations tab). */
const PLATFORM_SERVICE_SECTIONS: readonly string[] = ['defaults', 'email', 'transcription', 'connected-apps'];
/** The People tab's own tabs of the users screen; the rest are rows of their own. */
const PEOPLE_SECTIONS: readonly string[] = ['users', 'invitations', 'groups', 'org-roles'];

/** The licence row's page: the global feature switches (the frame names them: the list only), or the server licence. */
function LicensePage({ section }: { section?: string }) {
    return section === 'features' ? <FeatureKillSwitches bare /> : <ServerLicensePanel />;
}

/** An address segment as a panel prop: an empty one is none. */
const seg = (value: string | undefined): string | undefined => value || undefined;

/**
 * The panel of each tab and its frame; a tab without one renders nothing here
 * (product-website escapes the chrome). A hub's sections are rail rows, so
 * every hub renders without its own section column (D5); the list/detail tools
 * keep theirs and fill the pane.
 */
const PANELS: Record<string, Panel> = {
    agents: { render: (p) => <AgentConfigHub nav={false} hasPermission={p.hasPermission} activeSection={p.agentSection} />, frame: FILL_INSET },
    organisation: {
        render: (p) => <OrganisationHub activeSection={p.adminPath.seg2} title={p.title} description={p.description} />,
        frame: 'own',
    },
    people: { render: (p) => <UserManagement sections={PEOPLE_SECTIONS} activeSection={p.adminPath.seg2} />, frame: FILL },
    'ai-config': {
        render: (p) => <AIConfigPanel nav={false} activeSection={p.adminPath.seg2} activeProvider={p.adminPath.seg3} />,
        frame: bySection(['retrieval', 'direct-chat', 'limits'], 'providers'),
    },
    security: {
        render: (p) => <SecurityHub nav={false} activeSection={p.adminPath.seg2} userSection={p.adminPath.seg3} />,
        frame: bySection(['sso'], 'guardrails'),
    },
    integrations: {
        render: (p) => <IntegrationsAdminPanel sections={PLATFORM_SERVICE_SECTIONS} activeSection={p.adminPath.seg2} />,
        frame: bySection(['defaults', 'email'], 'defaults'),
    },
    access: { render: (p) => <AccessPermissionsPanel tabs activeSection={p.adminPath.seg2} />, frame: WIDE },
    // nav={false}: the panel neither pads nor scrolls itself; the frame does both. The panel's first line is the
    // description in the header's small style plus the scope, so the header names the page only (no second copy).
    monitoring: { render: (p) => <MonitoringPanel nav={false} activeSection={p.adminPath.seg2} />, frame: WIDE_NAME_ONLY },
    compliance: { render: (p) => <ComplianceHub activeSection={p.adminPath.seg2} focusCheckId={p.adminPath.seg3} />, frame: FILL },
    // nav={false}: its sections are child rows of the rail; each page pads and scrolls itself.
    subscriptions: { render: (p) => <SubscriptionsPanel nav={false} activeSection={p.adminPath.seg2} />, frame: FILL },
    // admin/support/<view>/<item>; the server's ticket link admin/support/<threadId> is a view the panel resolves.
    support: { render: (p) => <SupportInboxPanel view={p.adminPath.seg2 ?? ''} item={seg(p.adminPath.seg3)} />, frame: FILL_INSET },
    licenses: { render: (p) => <LicensePage section={p.adminPath.seg2} />, frame: SETTINGS },
    modules: { render: () => <ModulesPanel />, frame: WIDE },
    appearance: { render: (p) => <AppearancePanel section={p.adminPath.seg2 === 'icon-packs' ? 'icon-packs' : 'look'} />, frame: FILL_INSET },
    languages: { render: (p) => <LanguagesPanel locale={seg(p.adminPath.seg2)} section={seg(p.adminPath.seg3)} />, frame: FILL_INSET },
    organisations: { render: () => <UserManagement sections={['organizations']} activeSection="organizations" />, frame: FILL },
    roles: { render: (p) => <UserManagement sections={['roles', 'permissions']} activeSection={p.adminPath.seg2 || 'roles'} />, frame: FILL },
    'mcp-servers': { render: () => <ServerMcpPanel />, frame: WIDE },
    'nextcloud-instances': { render: (p) => <NextcloudInstancesPanel section={p.adminPath.seg2} orgId={p.adminPath.seg3} />, frame: FILL },
    'website-analytics': { render: (p) => <AnalyticsPanel activeSection={seg(p.adminPath.seg2)} />, frame: FILL },
    'release-notes': { render: () => <ReleaseNotesPanel />, frame: SETTINGS },
};

export default function AdminTabContent(props: AdminTabContentProps) {
    const panel = Object.hasOwn(PANELS, props.activeTab) ? PANELS[props.activeTab] : null;
    if (!panel) return null;
    return (
        <Frame tab={props.activeTab} frame={panel.frame} section={props.adminPath.seg2 ?? ''} title={props.title} description={props.description}>
            {panel.render(props)}
        </Frame>
    );
}
